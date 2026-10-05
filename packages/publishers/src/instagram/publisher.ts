import {
  type AbortSignalLike,
  type InstagramProgress,
  instagramProgressSchema,
  isAppError,
  type PublishContext,
  type Publisher,
  type PublishInput,
  type PublishResult,
} from "@agentsales/core";
import { INSTAGRAM_POLL, INSTAGRAM_REEL_THUMB_OFFSET_MS } from "./constants.js";
import { INSTAGRAM_ERRORS, instagramError } from "./errors.js";
import { type ContainerRequest, createInstagramGraph, type InstagramGraph } from "./graph.js";
import { validateInstagramInput } from "./validate.js";

/** Algo que el publisher anota sin cortar el intento (el worker lo registra, sin datos del aviso). */
export type InstagramPublishNote = {
  /** `content_publishing_limit` no respondió (con Instagram Login está sin verificar, nota §6). */
  code: "QUOTA_UNAVAILABLE";
  errorCode: string;
};

export type InstagramPublisherOptions = {
  /**
   * Arma el cliente de la Graph API la primera vez que se publica (spec F3 §4.5): validar y
   * simular (`withDryRun`) nunca lo construyen. Por defecto, `createInstagramGraph()`.
   */
  graph?: () => InstagramGraph;
  /** Reloj y espera, para probar el sondeo con relojes falsos. */
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignalLike) => Promise<void>;
  /** Ritmo del sondeo; por defecto `INSTAGRAM_POLL`. */
  poll?: { firstDelaysMs: readonly number[]; intervalMs: number; maxWaitMs: number };
  /** Cuántos medios recientes se revisan para reconocer uno ya publicado. */
  recentMediaLimit?: number;
  onNote?: (note: InstagramPublishNote) => void;
};

/** Margen para comparar la hora de Instagram con la nuestra al buscar un medio ya publicado. */
const CLOCK_SKEW_MS = 2 * 60_000;

/** Espera `ms`, o corta con `IG_ABORTED` si se dispara la señal. */
export function abortableSleep(ms: number, signal?: AbortSignalLike): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(INSTAGRAM_ERRORS.aborted());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(INSTAGRAM_ERRORS.aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Publisher de Instagram (spec F3 §4.4 y §4.5, ADR-0014): `post` (imagen suelta o carrusel) y
 * `reel`. Cada intento:
 * 1. Retoma desde `ctx.progress` si hay un contenedor: `FINISHED` lo publica, `PUBLISHED` busca el
 *    medio entre los últimos de la cuenta (o `IG_PUBLISH_OUTCOME_UNKNOWN`), `IN_PROGRESS` sigue
 *    esperando y `EXPIRED` o `ERROR` arman contenedores nuevos. Así nunca hay dos `media_publish`
 *    sobre el mismo contenedor sin consultar antes su estado.
 * 2. Si no, revisa el cupo (`IG_PUBLISH_LIMIT`), crea los contenedores, **guarda el progreso** y
 *    sondea hasta `FINISHED` (`IG_CONTAINER_TIMEOUT` a los 5 min).
 * 3. `media_publish` y el `permalink` (del carrusel, no de los hijos).
 * No valida: el intento corre `checkPublishInput` antes (T11). Un `media_publish` que no terminó
 * se relanza tal cual: el reintento lo resuelve por el progreso.
 */
export function createInstagramPublisher(options: InstagramPublisherOptions = {}): Publisher {
  let client: InstagramGraph | undefined;
  const graph = () => {
    client ??= (options.graph ?? (() => createInstagramGraph()))();
    return client;
  };
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? abortableSleep;
  const poll = options.poll ?? INSTAGRAM_POLL;
  const recentLimit = options.recentMediaLimit ?? 10;

  return {
    platform: "instagram",
    formats: ["post", "reel"],
    validate: validateInstagramInput,
    async publish(input, ctx) {
      if (ctx.signal?.aborted) throw INSTAGRAM_ERRORS.aborted();
      const attempt = new Attempt(graph(), input, ctx, { now, sleep, poll, recentLimit });
      const saved = instagramProgressSchema.safeParse(ctx.progress);
      if (saved.success && saved.data.containerId !== null) {
        const resumed = await attempt.resume({
          ...saved.data,
          containerId: saved.data.containerId,
        });
        if (resumed !== null) return resumed;
      }
      await attempt.checkQuota(options.onNote);
      return attempt.fresh();
    },
  };
}

type AttemptTools = {
  now: () => Date;
  sleep: (ms: number, signal?: AbortSignalLike) => Promise<void>;
  poll: { firstDelaysMs: readonly number[]; intervalMs: number; maxWaitMs: number };
  recentLimit: number;
};

/** Un intento de publicación: la cuenta, el token y la señal, para no repetirlos en cada llamada. */
class Attempt {
  private readonly token: string;
  private readonly igUserId: string;
  private readonly call: { signal?: AbortSignalLike };

  constructor(
    private readonly graph: InstagramGraph,
    private readonly input: PublishInput,
    private readonly ctx: PublishContext,
    private readonly tools: AttemptTools,
  ) {
    this.token = ctx.credentials.accessToken;
    this.igUserId = ctx.account.externalAccountId;
    this.call = ctx.signal === undefined ? {} : { signal: ctx.signal };
  }

  /** Retoma desde un contenedor guardado; `null` si hay que armar contenedores nuevos. */
  async resume(
    progress: InstagramProgress & { containerId: string },
  ): Promise<PublishResult | null> {
    const status = await this.graph.containerStatus(this.token, progress.containerId, this.call);
    switch (status.statusCode) {
      case "PUBLISHED":
        return this.findPublished(progress.attemptStartedAt);
      case "FINISHED":
        return this.publishContainer(progress.containerId, progress.attemptStartedAt);
      case "IN_PROGRESS":
      case "UNKNOWN":
        // Recién consultado: espera antes de volver a preguntar.
        return this.waitAndPublish(progress.containerId, progress.attemptStartedAt, false);
      case "EXPIRED":
      case "ERROR":
        return null;
    }
  }

  /** Sin cupo, `IG_PUBLISH_LIMIT`; si el endpoint no responde, se sigue y se anota. */
  async checkQuota(onNote: InstagramPublisherOptions["onNote"]): Promise<void> {
    try {
      const limit = await this.graph.publishingLimit(this.token, this.igUserId, this.call);
      if (limit.quotaTotal !== null && limit.quotaUsage >= limit.quotaTotal) {
        throw instagramError({ code: 9 });
      }
    } catch (error) {
      if (
        isAppError(error) &&
        (error.code === "IG_REQUEST_REJECTED" || error.code === "IG_UNEXPECTED_RESPONSE")
      ) {
        onNote?.({ code: "QUOTA_UNAVAILABLE", errorCode: error.code });
        return;
      }
      throw error;
    }
  }

  /** Contenedores nuevos, progreso guardado, sondeo y publicación. */
  async fresh(): Promise<PublishResult> {
    const attemptStartedAt = this.tools.now().toISOString();
    const childIds: string[] = [];
    let request: ContainerRequest;
    if (this.input.format === "reel") {
      const [video] = this.input.media;
      request = {
        kind: "reel",
        videoUrl: video?.url ?? "",
        caption: this.input.caption,
        thumbOffsetMs: INSTAGRAM_REEL_THUMB_OFFSET_MS,
        shareToFeed: true,
      };
    } else if (this.input.media.length === 1) {
      request = {
        kind: "image",
        imageUrl: this.input.media[0]?.url ?? "",
        caption: this.input.caption,
      };
    } else {
      for (const item of this.input.media) {
        childIds.push(await this.create({ kind: "carousel_item", imageUrl: item.url }));
      }
      await this.waitFinished(childIds);
      request = { kind: "carousel", children: childIds, caption: this.input.caption };
    }
    const containerId = await this.create(request);
    // Antes de esperar y publicar: un corte desde aquí se retoma sobre este contenedor.
    await this.ctx.saveProgress({
      attemptStartedAt,
      childIds,
      containerId,
    } satisfies InstagramProgress);
    return this.waitAndPublish(containerId, attemptStartedAt);
  }

  /** Espera el contenedor y lo publica; si alguien ya lo publicó, busca el medio. */
  private async waitAndPublish(containerId: string, attemptStartedAt: string, checkFirst = true) {
    return (await this.waitFinished([containerId], checkFirst)) === "published"
      ? this.findPublished(attemptStartedAt)
      : this.publishContainer(containerId, attemptStartedAt);
  }

  private create(request: ContainerRequest): Promise<string> {
    return this.graph.createContainer(this.token, this.igUserId, request, this.call);
  }

  /**
   * Sondea hasta que todos estén `FINISHED` (spec F3 §4.5): a los 5, 10, 20 y 30 s y luego cada
   * 60 s, hasta 5 min. `ERROR` se clasifica por su subcódigo (sin subcódigo, reintentable con
   * contenedores nuevos) y `EXPIRED` se rehace en el reintento. Devuelve `published` si alguno ya
   * estaba publicado (no se vuelve a publicar). Con `checkFirst` en `false` (el estado se acaba de
   * consultar), espera antes de la primera consulta.
   */
  private async waitFinished(
    containerIds: readonly string[],
    checkFirst = true,
  ): Promise<"finished" | "published"> {
    const { firstDelaysMs, intervalMs, maxWaitMs } = this.tools.poll;
    const started = this.tools.now().getTime();
    let pending = [...containerIds];
    let published = false;
    for (let round = 0; ; round += 1) {
      if (round > 0 || checkFirst) {
        pending = await this.stillPending(pending, () => {
          published = true;
        });
        if (pending.length === 0) return published ? "published" : "finished";
      }
      const delay = firstDelaysMs[round] ?? intervalMs;
      if (this.tools.now().getTime() - started + delay > maxWaitMs) {
        throw INSTAGRAM_ERRORS.containerTimeout();
      }
      await this.tools.sleep(delay, this.ctx.signal);
    }
  }

  /** Consulta cada contenedor y devuelve los que siguen en proceso. */
  private async stillPending(
    containerIds: readonly string[],
    onPublished: () => void,
  ): Promise<string[]> {
    const still: string[] = [];
    for (const id of containerIds) {
      const status = await this.graph.containerStatus(this.token, id, this.call);
      if (status.statusCode === "ERROR") {
        throw status.subcode === null
          ? instagramError({ code: 2 })
          : instagramError({ subcode: status.subcode });
      }
      if (status.statusCode === "EXPIRED") throw instagramError({ subcode: 2207020 });
      if (status.statusCode === "PUBLISHED") onPublished();
      else if (status.statusCode !== "FINISHED") still.push(id);
    }
    return still;
  }

  /**
   * `media_publish` y el enlace. Si Instagram dice que el medio aún no está listo, se vuelve a
   * consultar el estado antes de repetirlo. El enlace se pide aparte: si esa lectura falla, la
   * publicación ya salió y queda sin enlace (no se repite nada).
   */
  private async publishContainer(
    containerId: string,
    attemptStartedAt: string,
  ): Promise<PublishResult> {
    let mediaId: string;
    for (;;) {
      try {
        mediaId = await this.graph.publishContainer(
          this.token,
          this.igUserId,
          containerId,
          this.call,
        );
        break;
      } catch (error) {
        if (!isAppError(error) || error.code !== "IG_MEDIA_NOT_READY") throw error;
        if ((await this.waitFinished([containerId], false)) === "published") {
          return this.findPublished(attemptStartedAt);
        }
      }
    }
    let permalink: string | null = null;
    try {
      permalink = (await this.graph.media(this.token, mediaId, this.call)).permalink;
    } catch {
      // Publicado sin enlace: el operador lo ve en Instagram; no se reintenta.
    }
    return { externalId: mediaId, externalUrl: permalink, simulated: false };
  }

  /**
   * Un contenedor `PUBLISHED` (un intento anterior publicó y no alcanzó a guardarlo): busca el
   * medio entre los últimos de la cuenta, con el mismo caption y publicado después de ese intento.
   */
  private async findPublished(attemptStartedAt: string): Promise<PublishResult> {
    const since = new Date(attemptStartedAt).getTime() - CLOCK_SKEW_MS;
    const recent = await this.graph.recentMedia(this.token, this.igUserId, {
      ...this.call,
      limit: this.tools.recentLimit,
    });
    const found = recent.find(
      (media) =>
        (media.caption ?? "").trim() === this.input.caption.trim() &&
        media.timestamp !== null &&
        media.timestamp.getTime() >= since,
    );
    if (found === undefined) throw INSTAGRAM_ERRORS.publishOutcomeUnknown();
    return { externalId: found.id, externalUrl: found.permalink, simulated: false };
  }
}
