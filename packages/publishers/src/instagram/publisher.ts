import {
  type AbortSignalLike,
  AppError,
  checkPublishInput,
  type DirectPublisher,
  type InstagramProgress,
  instagramProgressSchema,
  isAppError,
  type PublishContext,
  type PublishInput,
  type PublishResult,
} from "@agentsales/core";
import { INSTAGRAM_POLL, INSTAGRAM_REEL_THUMB_OFFSET_MS } from "./constants.js";
import { INSTAGRAM_ERRORS, instagramContainerError, instagramError } from "./errors.js";
import {
  type ContainerRequest,
  createInstagramGraph,
  type InstagramGraph,
  type InstagramMedia,
} from "./graph.js";
import { validateInstagramInput } from "./validate.js";

/**
 * Algo que el publisher anota sin cortar el intento: el worker lo registra con el `publicationId`
 * (sin datos del aviso).
 * - `QUOTA_UNAVAILABLE`: `content_publishing_limit` no respondió (con Instagram Login está sin
 *   verificar, nota §6): se publica sin consultar el cupo.
 * - `QUOTA_TOTAL_UNKNOWN`: respondió sin `quota_total`: se publica sin comparar.
 */
export type InstagramPublishNote = {
  publicationId: string;
  code: "QUOTA_UNAVAILABLE" | "QUOTA_TOTAL_UNKNOWN";
  errorCode?: string;
};

type PollPlan = { firstDelaysMs: readonly number[]; intervalMs: number; maxWaitMs: number };

export type InstagramPublisherOptions = {
  /**
   * Arma el cliente de la Graph API la primera vez que se publica (spec F3 §4.5): validar y
   * simular (`withDryRun`) nunca lo construyen. Por defecto, `createInstagramGraph()`.
   */
  graph?: () => InstagramGraph;
  /** Reloj y espera, para probar el sondeo con relojes falsos. */
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignalLike) => Promise<void>;
  /** Ritmo del sondeo de cada contenedor; por defecto `INSTAGRAM_POLL` (hasta 5 min). */
  poll?: PollPlan;
  /**
   * Tope de todo el intento (hijos, padre y publicación), menor que el vencimiento del job
   * `publication.publish` (15 min, spec F3 §4.4): así un intento nunca se cruza con su reintento.
   */
  attemptMaxMs?: number;
  onNote?: (note: InstagramPublishNote) => void;
};

/** Tope de un intento por defecto: 12 min, bajo los 15 del job. */
export const INSTAGRAM_ATTEMPT_MAX_MS = 12 * 60_000;
/** Cuántos medios recientes se revisan para reconocer uno ya publicado. */
const RECENT_MEDIA_LIMIT = 10;
/** Margen para comparar la hora de Instagram con la nuestra al buscar un medio ya publicado. */
const CLOCK_SKEW_MS = 2 * 60_000;
/** Lo que se espera tras un `media_publish` sin respuesta antes de volver a mirar el contenedor. */
const PUBLISH_SETTLE_MS = 60_000;
/** Veces que se pide `media_publish` si Instagram dice que el medio aún no está listo. */
const NOT_READY_TRIES = 3;

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

/** Caption comparable: sin `\r`, sin espacios al final de cada línea ni en los bordes. */
const comparableCaption = (caption: string) =>
  caption
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();

/** Si un medio de la cuenta es del mismo formato: `reel` con `REELS`; `post` con el feed. */
function sameFormat(media: InstagramMedia, format: PublishInput["format"]): boolean {
  if (format === "reel") {
    return (
      media.productType === "REELS" || (media.productType === null && media.mediaType === "VIDEO")
    );
  }
  if (media.productType === "REELS") return false;
  return media.mediaType === "IMAGE" || media.mediaType === "CAROUSEL_ALBUM";
}

/**
 * Publisher de Instagram (spec F3 §4.4 y §4.5, ADR-0014): `post` (imagen suelta o carrusel) y
 * `reel`. Cada intento revisa el input (`checkPublishInput`) y:
 * 1. Retoma desde `ctx.progress` si hay un contenedor:
 *    - `FINISHED` lo publica (si un intento anterior ya pidió `media_publish` y no leyó la
 *      respuesta, antes espera y busca el medio);
 *    - `PUBLISHED` busca el medio entre los últimos de la cuenta, del mismo formato y caption, o da
 *      `IG_PUBLISH_OUTCOME_UNKNOWN`;
 *    - `IN_PROGRESS` espera lo que le queda de sus 5 min; si ya los gastó, se abandona;
 *    - `EXPIRED`, `ERROR` o abandonado: contenedores nuevos (ninguno está publicado).
 *    Así nunca hay dos `media_publish` sobre el mismo contenedor sin consultar antes su estado.
 * 2. Si no, revisa el cupo (`IG_PUBLISH_LIMIT`), crea los contenedores, **guarda el progreso** y
 *    sondea hasta `FINISHED` (`IG_CONTAINER_TIMEOUT` a los 5 min, reintentable con contenedores
 *    nuevos).
 * 3. Guarda la hora del pedido, `media_publish` y el `permalink` (del carrusel, no de los hijos).
 * Un `media_publish` que no terminó se relanza tal cual: el reintento lo resuelve por el progreso.
 * Todo el intento tiene un tope (`attemptMaxMs`), bajo el vencimiento del job.
 */
export function createInstagramPublisher(options: InstagramPublisherOptions = {}): DirectPublisher {
  let client: InstagramGraph | undefined;
  const graph = () => {
    client ??= (options.graph ?? (() => createInstagramGraph()))();
    return client;
  };
  const tools: AttemptTools = {
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? abortableSleep,
    poll: options.poll ?? INSTAGRAM_POLL,
    attemptMaxMs: options.attemptMaxMs ?? INSTAGRAM_ATTEMPT_MAX_MS,
    onNote: options.onNote,
  };

  const publisher: DirectPublisher = {
    platform: "instagram",
    formats: ["post", "reel"],
    validate: validateInstagramInput,
    async publish(input, ctx) {
      checkPublishInput(publisher, input);
      if (ctx.signal?.aborted) throw INSTAGRAM_ERRORS.aborted();
      let saved: InstagramProgress | null = null;
      if (ctx.progress !== null && ctx.progress !== undefined) {
        const parsed = instagramProgressSchema.safeParse(ctx.progress);
        // Un progreso ilegible podría ser de un contenedor ya publicado: no se adivina.
        if (!parsed.success) throw INSTAGRAM_ERRORS.publishOutcomeUnknown();
        saved = parsed.data;
      }
      const attempt = new Attempt(graph(), input, ctx, tools);
      if (saved !== null && saved.containerId !== null) {
        const resumed = await attempt.resume({ ...saved, containerId: saved.containerId });
        if (resumed !== null) return resumed;
      }
      await attempt.checkQuota();
      return attempt.fresh();
    },
  };
  return publisher;
}

type AttemptTools = {
  now: () => Date;
  sleep: (ms: number, signal?: AbortSignalLike) => Promise<void>;
  poll: PollPlan;
  attemptMaxMs: number;
  onNote: InstagramPublisherOptions["onNote"];
};

type SavedContainer = InstagramProgress & { containerId: string };

/** Un intento de publicación: la cuenta, el token, la señal y su plazo. */
class Attempt {
  private readonly token: string;
  private readonly igUserId: string;
  private readonly call: { signal?: AbortSignalLike };
  /** Hasta cuándo puede correr este intento (ms desde 1970). */
  private readonly deadline: number;

  constructor(
    private readonly graph: InstagramGraph,
    private readonly input: PublishInput,
    private readonly ctx: PublishContext,
    private readonly tools: AttemptTools,
  ) {
    // El intento de Instagram siempre las pasa; solo Marketplace va sin credenciales (ADR-0017).
    if (ctx.credentials === undefined) {
      throw new AppError(
        "ACCOUNT_CREDENTIALS_REQUIRED",
        "Falta el acceso de la cuenta de Instagram",
      );
    }
    this.token = ctx.credentials.accessToken;
    this.igUserId = ctx.account.externalAccountId;
    this.call = ctx.signal === undefined ? {} : { signal: ctx.signal };
    this.deadline = this.nowMs() + tools.attemptMaxMs;
  }

  private nowMs() {
    return this.tools.now().getTime();
  }

  /** Retoma desde un contenedor guardado; `null` si hay que armar contenedores nuevos. */
  async resume(saved: SavedContainer): Promise<PublishResult | null> {
    const status = await this.graph.containerStatus(this.token, saved.containerId, this.call);
    switch (status.statusCode) {
      case "PUBLISHED":
        return this.foundOrUnknown(saved.attemptStartedAt);
      case "FINISHED":
        return this.publishContainer(saved);
      case "IN_PROGRESS":
      case "UNKNOWN": {
        // El contenedor tuvo 5 min desde su intento: si ya los gastó, está trabado y se rehace.
        const containerDeadline = Date.parse(saved.attemptStartedAt) + this.tools.poll.maxWaitMs;
        if (this.nowMs() >= containerDeadline) return null;
        const waited = await this.waitFinished([saved.containerId], {
          checkFirst: false,
          until: containerDeadline,
        });
        return waited === "published"
          ? this.foundOrUnknown(saved.attemptStartedAt)
          : this.publishContainer(saved);
      }
      case "EXPIRED":
      case "ERROR":
        return null;
    }
  }

  /**
   * Sin cupo, `IG_PUBLISH_LIMIT`. Si el endpoint no responde (rechazo, permiso o forma), se sigue
   * y se anota: un permiso de publicar que falte de verdad aparece al crear el contenedor.
   */
  async checkQuota(): Promise<void> {
    const note = (code: InstagramPublishNote["code"], errorCode?: string) =>
      this.tools.onNote?.({
        publicationId: this.input.publicationId,
        code,
        ...(errorCode === undefined ? {} : { errorCode }),
      });
    let limit: Awaited<ReturnType<InstagramGraph["publishingLimit"]>>;
    try {
      limit = await this.graph.publishingLimit(this.token, this.igUserId, this.call);
    } catch (error) {
      if (
        isAppError(error) &&
        ["IG_REQUEST_REJECTED", "IG_UNEXPECTED_RESPONSE", "IG_PERMISSION_DENIED"].includes(
          error.code,
        )
      ) {
        note("QUOTA_UNAVAILABLE", error.code);
        return;
      }
      throw error;
    }
    if (limit.quotaTotal === null) {
      note("QUOTA_TOTAL_UNKNOWN");
      return;
    }
    if (limit.quotaUsage >= limit.quotaTotal) throw instagramError({ code: 9 });
  }

  /** Contenedores nuevos, progreso guardado, sondeo y publicación. */
  async fresh(): Promise<PublishResult> {
    const attemptStartedAt = this.tools.now().toISOString();
    const childIds: string[] = [];
    const { input } = this;
    const [first] = input.media;
    // `checkPublishInput` ya exigió medios: esto solo protege el tipo.
    if (first === undefined) throw INSTAGRAM_ERRORS.unexpectedResponse("fresh");
    let request: ContainerRequest;
    if (input.format === "reel") {
      request = {
        kind: "reel",
        videoUrl: first.url,
        caption: input.caption,
        thumbOffsetMs: INSTAGRAM_REEL_THUMB_OFFSET_MS,
        shareToFeed: true,
      };
    } else if (input.media.length === 1) {
      request = { kind: "image", imageUrl: first.url, caption: input.caption };
    } else {
      for (const item of input.media) {
        childIds.push(await this.create({ kind: "carousel_item", imageUrl: item.url }));
      }
      await this.waitFinished(childIds, { until: this.pollDeadline() });
      request = { kind: "carousel", children: childIds, caption: input.caption };
    }
    const containerId = await this.create(request);
    const saved: SavedContainer = { attemptStartedAt, childIds, containerId };
    // Antes de esperar y publicar: un corte desde aquí se retoma sobre este contenedor.
    await this.ctx.saveProgress(saved);
    const waited = await this.waitFinished([containerId], { until: this.pollDeadline() });
    return waited === "published"
      ? this.foundOrUnknown(attemptStartedAt)
      : this.publishContainer(saved);
  }

  private create(request: ContainerRequest): Promise<string> {
    return this.graph.createContainer(this.token, this.igUserId, request, this.call);
  }

  /** Plazo de un sondeo: sus 5 min desde ahora, sin pasar el del intento. */
  private pollDeadline(): number {
    return Math.min(this.nowMs() + this.tools.poll.maxWaitMs, this.deadline);
  }

  /**
   * Sondea hasta que todos estén `FINISHED` (spec F3 §4.5): una consulta al empezar (las imágenes
   * suelen estar listas), y después a los 5, 10, 20 y 30 s y cada 60 s; la última, justo en el
   * plazo (`until`), y si siguen en proceso, `IG_CONTAINER_TIMEOUT`. `ERROR` se clasifica por su
   * subcódigo (sin subcódigo, reintentable con contenedores nuevos) y `EXPIRED` es reintentable.
   * Devuelve `published` si alguno ya estaba publicado (no se vuelve a publicar). Con `checkFirst`
   * en `false` (el estado se acaba de consultar), espera antes de la primera consulta.
   */
  private async waitFinished(
    containerIds: readonly string[],
    { until, checkFirst = true }: { until: number; checkFirst?: boolean },
  ): Promise<"finished" | "published"> {
    const { firstDelaysMs, intervalMs } = this.tools.poll;
    const deadline = Math.min(until, this.deadline);
    let pending = [...containerIds];
    let published = false;
    for (let round = 0; ; round += 1) {
      if (round > 0 || checkFirst) {
        pending = await this.stillPending(pending, () => {
          published = true;
        });
        if (pending.length === 0) return published ? "published" : "finished";
      }
      const remaining = deadline - this.nowMs();
      if (remaining <= 0) throw INSTAGRAM_ERRORS.containerTimeout();
      const delay = Math.min(firstDelaysMs[round] ?? intervalMs, remaining);
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
        throw instagramContainerError(status.subcode);
      }
      if (status.statusCode === "EXPIRED") throw instagramError({ subcode: 2207020 });
      if (status.statusCode === "PUBLISHED") onPublished();
      else if (status.statusCode !== "FINISHED") still.push(id);
    }
    return still;
  }

  /**
   * `media_publish` de un contenedor `FINISHED` y el enlace.
   * - Si un intento anterior ya lo pidió (`publishRequestedAt`) y no leyó la respuesta, espera a
   *   que Instagram termine, vuelve a mirar el contenedor y busca el medio antes de pedirlo otra vez.
   * - Guarda la hora del pedido antes de hacerlo.
   * - Si Instagram dice que el medio aún no está listo, vuelve a consultar el estado (hasta 3 pedidos).
   * - El enlace se pide aparte: si esa lectura falla, la publicación ya salió y queda sin enlace.
   */
  private async publishContainer(saved: SavedContainer): Promise<PublishResult> {
    if (saved.publishRequestedAt !== undefined) {
      const settleUntil = Date.parse(saved.publishRequestedAt) + PUBLISH_SETTLE_MS;
      const waitMs = Math.min(settleUntil, this.deadline) - this.nowMs();
      if (waitMs > 0) await this.tools.sleep(waitMs, this.ctx.signal);
      const status = await this.graph.containerStatus(this.token, saved.containerId, this.call);
      if (status.statusCode === "PUBLISHED") return this.foundOrUnknown(saved.attemptStartedAt);
      const found = await this.findPublished(saved.attemptStartedAt);
      if (found !== null) return found;
    }
    await this.ctx.saveProgress({
      ...saved,
      publishRequestedAt: this.tools.now().toISOString(),
    } satisfies InstagramProgress);
    let mediaId: string | undefined;
    for (let tries = 1; mediaId === undefined; tries += 1) {
      try {
        mediaId = await this.graph.publishContainer(
          this.token,
          this.igUserId,
          saved.containerId,
          this.call,
        );
      } catch (error) {
        if (!isAppError(error) || error.code !== "IG_MEDIA_NOT_READY") throw error;
        if (tries >= NOT_READY_TRIES) throw INSTAGRAM_ERRORS.containerTimeout();
        const waited = await this.waitFinished([saved.containerId], {
          checkFirst: false,
          until: this.pollDeadline(),
        });
        if (waited === "published") return this.foundOrUnknown(saved.attemptStartedAt);
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

  /** El medio ya publicado, o `IG_PUBLISH_OUTCOME_UNKNOWN` si no se reconoce. */
  private async foundOrUnknown(attemptStartedAt: string): Promise<PublishResult> {
    const found = await this.findPublished(attemptStartedAt);
    if (found === null) throw INSTAGRAM_ERRORS.publishOutcomeUnknown();
    return found;
  }

  /**
   * Busca el medio que publicó un intento anterior entre los últimos de la cuenta: del mismo
   * formato (el carrusel y el reel de un aviso llevan el mismo caption), con el mismo caption y
   * publicado desde poco antes de ese intento. Si hay varios, el más antiguo.
   */
  private async findPublished(attemptStartedAt: string): Promise<PublishResult | null> {
    const since = Date.parse(attemptStartedAt) - CLOCK_SKEW_MS;
    const caption = comparableCaption(this.input.caption);
    const recent = await this.graph.recentMedia(this.token, this.igUserId, {
      ...this.call,
      limit: RECENT_MEDIA_LIMIT,
    });
    const matches = recent.filter(
      (media) =>
        sameFormat(media, this.input.format) &&
        comparableCaption(media.caption ?? "") === caption &&
        media.timestamp !== null &&
        media.timestamp.getTime() >= since,
    );
    const found = matches.at(-1);
    return found === undefined
      ? null
      : { externalId: found.id, externalUrl: found.permalink, simulated: false };
  }
}
