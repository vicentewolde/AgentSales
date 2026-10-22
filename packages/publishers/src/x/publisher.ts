import {
  type AbortSignalLike,
  type AccessTokenProvider,
  AppError,
  checkPublishInput,
  type DirectPublisher,
  formatXUsd,
  isAppError,
  POST_TEXT_LIMITS,
  type PublicationOperations,
  type PublishContext,
  type PublishInput,
  type PublishIssue,
  type PublishMediaItem,
  type PublishValidation,
  pendingSend,
  platformContextOf,
  sendOnce,
  xAccountMetaSchema,
  xPostCostUsd,
  xPostUrl,
  xWeightedLength,
} from "@agentsales/core";
import { z } from "zod";
import { createXApi, type XApiClient, type XUploadStream } from "./api.js";
import {
  X_IMAGE_TYPES,
  X_LIMITS,
  X_MEDIA_DOWNLOAD_TIMEOUT_MS,
  X_MEDIA_REUSE_MARGIN_MS,
} from "./constants.js";
import { isXNotSent, X_ERRORS } from "./errors.js";

/** Lo que pasa en un intento y va al log del worker: solo ids, códigos y cifras, nunca un token. */
export type XPublishNote = { publicationId: string } & (
  | { kind: "media_uploaded"; count: number; reused: boolean }
  | { kind: "token_renewed_after_401"; call: string }
);

export type XPublisherOptions = {
  /** Por defecto `createXApi()`. */
  api?: XApiClient;
  /**
   * Baja un medio de R2 por su URL firmada (de 1 hora, recién creada en el intento); por defecto con
   * `fetch` y un tope. Nunca pone la URL en un error.
   */
  download?: (item: PublishMediaItem, options: { signal?: AbortSignalLike }) => Promise<Uint8Array>;
  /**
   * Abre el video de R2 como flujo para subirlo por partes sin tenerlo entero en memoria
   * (F9.5-T08); por defecto `openXVideo`, con `fetch`. Un reintento tras un 401 lo vuelve a abrir.
   */
  openVideo?: (
    item: PublishMediaItem,
    options: { signal?: AbortSignalLike },
  ) => Promise<XUploadStream>;
  now?: () => Date;
  onNote?: (note: XPublishNote) => void;
};

/**
 * Lo que guarda el publisher de X en su progreso, al lado de `send` y `manual` (que conserva):
 * los medios ya subidos, en el orden del post, con su vencimiento (24 h). Un reintento los
 * reutiliza si son los mismos y les queda más de 1 hora.
 */
export const xMediaProgressSchema = z.object({
  items: z.array(z.object({ mediaId: z.string(), xMediaId: z.string().regex(/^\d{1,30}$/) })),
  expiresAt: z.iso.datetime(),
});
export type XMediaProgress = z.infer<typeof xMediaProgressSchema>;

const xProgressSchema = z.looseObject({ xMedia: xMediaProgressSchema.optional().catch(undefined) });

/** Lo propio del publisher (sin `send` ni `manual`, que suma `sendOnce`). */
function ownPart(progress: unknown): Record<string, unknown> {
  if (progress === null || typeof progress !== "object" || Array.isArray(progress)) return {};
  const { send: _send, manual: _manual, ...rest } = progress as Record<string, unknown>;
  return rest;
}

/**
 * Lo que X no aceptaría (pura, sin red; la usa también `withDryRun`): el texto hasta 280
 * caracteres ponderados (`xWeightedLength`: URL = 23, emoji = 2), hasta 4 imágenes **o** 1 video
 * (sin mezclar), cada imagen JPEG, PNG, WebP o GIF de hasta 5 MB, el video de 0,5 s a 20 min y bajo
 * el tope de bajada, y que el post no quede vacío.
 */
export function validateXInput(input: PublishInput): PublishValidation {
  const issues: PublishIssue[] = [];
  const length = xWeightedLength(input.caption);
  if (length > POST_TEXT_LIMITS.x) {
    issues.push({
      code: "X_TEXT_TOO_LONG",
      message: `El texto tiene ${length} caracteres ponderados y X admite ${POST_TEXT_LIMITS.x} (un enlace cuenta 23 y un emoji, 2)`,
    });
  }
  const images = input.media.filter((item) => item.kind !== "video");
  const videos = input.media.filter((item) => item.kind === "video");
  if (images.length > 0 && videos.length > 0) {
    issues.push({
      code: "X_MEDIA_MIXED",
      message: "X no mezcla imágenes y video en un post: van hasta 4 imágenes o 1 video",
    });
  }
  if (images.length > X_LIMITS.images) {
    issues.push({
      code: "X_TOO_MANY_IMAGES",
      message: `X admite hasta ${X_LIMITS.images} imágenes por post`,
    });
  }
  if (videos.length > X_LIMITS.videos) {
    issues.push({ code: "X_TOO_MANY_VIDEOS", message: "X admite un solo video por post" });
  }
  if (images.some((item) => !X_IMAGE_TYPES.has(item.mime))) {
    issues.push({
      code: "X_IMAGE_TYPE",
      message: "X acepta imágenes JPEG, PNG, WebP o GIF",
    });
  }
  if (images.some((item) => item.bytes > X_LIMITS.imageBytes)) {
    issues.push({ code: "X_IMAGE_TOO_LARGE", message: "Una imagen pesa más de los 5 MB de X" });
  }
  for (const video of videos) {
    if (video.bytes > X_LIMITS.videoBytes) {
      issues.push({ code: "X_VIDEO_TOO_LARGE", message: "El video pesa demasiado para X" });
    }
    if (
      video.durationS !== null &&
      (video.durationS < X_LIMITS.videoMinSeconds || video.durationS > X_LIMITS.videoMaxSeconds)
    ) {
      issues.push({
        code: "X_VIDEO_DURATION",
        message: "X acepta videos de 0,5 s a 20 minutos en una cuenta sin Premium",
      });
    }
  }
  if (input.caption.trim() === "" && input.media.length === 0) {
    issues.push({ code: "X_EMPTY_POST", message: "El post quedaría vacío: falta el texto" });
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/** La nota del costo estimado (bitácora), sin datos del post. */
export const xCostNote = (caption: string): string =>
  `En X costaría ${formatXUsd(xPostCostUsd(caption))} (estimado; el saldo real está en la consola de X)`;

/** Un medio de R2 abierto como flujo: el tamaño anunciado (o `null`) y sus trozos. */
export type XMediaStream = {
  /** El `content-length` de R2, o `null` si no vino. */
  totalBytes: number | null;
  /** Se leen una vez; `return()` cierra la descarga (también si nunca se empezó a leer). */
  chunks: AsyncIterable<Uint8Array>;
};

/**
 * Abre un medio por su URL firmada como flujo (F9.5-T08), con tope de tamaño y de tiempo: la
 * respuesta tiene que llegar en `X_MEDIA_DOWNLOAD_TIMEOUT_MS`, y cada trozo también (la espera entre
 * trozos, no el total: el video se lee a medida que sube a X, parte por parte). Un `content-length`
 * mayor que el tope falla sin leer. Ningún error lleva la URL: `X_MEDIA_UNAVAILABLE` (reintentable;
 * no se envió nada) o `X_ABORTED`.
 */
export async function openXMedia(
  item: PublishMediaItem,
  { signal }: { signal?: AbortSignalLike } = {},
): Promise<XMediaStream> {
  if (signal?.aborted) throw X_ERRORS.aborted();
  const limit = item.kind === "video" ? X_LIMITS.videoBytes : X_LIMITS.imageBytes;
  const caller = new AbortController();
  const idle = new AbortController();
  const onAbort = () => caller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    timer = setTimeout(() => idle.abort(), X_MEDIA_DOWNLOAD_TIMEOUT_MS);
  };
  const disarm = () => clearTimeout(timer);
  const failure = (reason: "network" | "timeout") =>
    caller.signal.aborted
      ? X_ERRORS.aborted()
      : X_ERRORS.mediaUnavailable(item.mediaId, idle.signal.aborted ? "timeout" : reason);
  let closed = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const close = async () => {
    if (closed) return;
    closed = true;
    disarm();
    signal?.removeEventListener("abort", onAbort);
    await reader?.cancel().catch(() => undefined);
  };
  try {
    let response: Response;
    arm();
    try {
      response = await fetch(item.url, {
        redirect: "error",
        signal: AbortSignal.any([caller.signal, idle.signal]),
      });
    } catch {
      throw failure("network");
    } finally {
      disarm();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw X_ERRORS.mediaUnavailable(item.mediaId, `http_${response.status}`);
    }
    const header = response.headers.get("content-length");
    const declared = header === null || header.trim() === "" ? Number.NaN : Number(header);
    const totalBytes = Number.isSafeInteger(declared) && declared >= 0 ? declared : null;
    if (totalBytes !== null && (totalBytes === 0 || totalBytes > limit)) {
      await response.body?.cancel().catch(() => undefined);
      throw X_ERRORS.mediaUnavailable(item.mediaId, totalBytes === 0 ? "size" : "too_large");
    }
    if (response.body === null) throw X_ERRORS.mediaUnavailable(item.mediaId, "size");
    reader = response.body.getReader();
    const body = reader;
    let read = 0;
    const iterator: AsyncIterator<Uint8Array> = {
      async next() {
        if (closed) return { done: true, value: undefined };
        let next: Awaited<ReturnType<typeof body.read>>;
        arm();
        try {
          next = await body.read();
        } catch {
          const error = failure("network");
          await close();
          throw error;
        } finally {
          disarm();
        }
        if (next.done) {
          await close();
          return { done: true, value: undefined };
        }
        read += next.value.byteLength;
        if (read > limit) {
          await close();
          throw X_ERRORS.mediaUnavailable(item.mediaId, "too_large");
        }
        return { done: false, value: next.value };
      },
      async return() {
        await close();
        return { done: true, value: undefined };
      },
    };
    return { totalBytes, chunks: { [Symbol.asyncIterator]: () => iterator } };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Baja una imagen entera por su URL firmada (hasta 5 MB), con `openXMedia`: su mismo tope de
 * tiempo y de tamaño, y ningún error lleva la URL.
 */
export async function downloadXMedia(
  item: PublishMediaItem,
  options: { signal?: AbortSignalLike } = {},
): Promise<Uint8Array> {
  const opened = await openXMedia(item, options);
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of opened.chunks) {
    parts.push(chunk);
    size += chunk.byteLength;
  }
  if (size === 0 || (opened.totalBytes !== null && size !== opened.totalBytes)) {
    throw X_ERRORS.mediaUnavailable(item.mediaId, "size");
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/**
 * Abre el video por su URL firmada para subirlo a X por partes (F9.5-T08): sin el `content-length`
 * de R2 no se puede hacer el INIT, y es `X_MEDIA_UNAVAILABLE` (`no_length`) sin leer nada.
 */
export async function openXVideo(
  item: PublishMediaItem,
  options: { signal?: AbortSignalLike } = {},
): Promise<XUploadStream> {
  const opened = await openXMedia(item, options);
  if (opened.totalBytes === null) {
    await opened.chunks[Symbol.asyncIterator]().return?.();
    throw X_ERRORS.mediaUnavailable(item.mediaId, "no_length");
  }
  return {
    mediaId: item.mediaId,
    mime: item.mime,
    totalBytes: opened.totalBytes,
    chunks: opened.chunks,
  };
}

/** El usuario de la cuenta (para el enlace del post), o `null` si la `meta` no lo trae. */
function usernameOf(ctx: Pick<PublishContext, "account">): string | null {
  const meta = xAccountMetaSchema.pick({ username: true }).safeParse(ctx.account.meta);
  return meta.success ? meta.data.username : null;
}

/** Si un error es el 401 de X (el token venció o se revocó): se pide otro una vez. */
const isUnauthorized = (error: unknown) =>
  isAppError(error) &&
  error.code === "X_AUTH_INVALID" &&
  (error.details as { httpStatus?: unknown } | undefined)?.httpStatus === 401;

/**
 * Publisher de X (spec F9 §4.4 a §4.6 y §4.12; F9-T16):
 * 1. revisa el input (`validateXInput`). La marca del enlace, el tope de gasto del mes y el costo
 *    (`cost_usd`) los revisa core **antes** de llamar aquí (`publishPublication`);
 * 2. si el progreso no tiene un envío anterior: pide el token (`ctx.accessToken`, que lo renueva con
 *    `ensureRotatingAccessToken` si le quedan menos de 30 min) y sube los medios **antes** de
 *    marcar "enviando" (un fallo al subir no deja nada dudoso): las imágenes de una vez, bajadas de
 *    R2, y el video por partes (INIT, APPEND de 4 MB, FINALIZE y el estado hasta `succeeded`),
 *    leyéndolo de R2 como flujo mientras sube (F9.5-T08: nunca entero en memoria).
 *    Guarda sus ids en el progreso (`xMedia`, al lado de `send` y `manual`); un reintento los
 *    reutiliza si son los mismos medios y no vencen en la próxima hora;
 * 3. publica **una vez** con `sendOnce` (ADR-0029 punto 8): `POST /2/tweets` con el texto y los
 *    `media_ids`. Un 401 pide otro token (`rejectedToken`) y repite una sola vez (el 401 prueba que
 *    no se creó). Los errores que prueban que no salió (`X_NOT_SENT_CODES`: el 402 por saldo, el 429
 *    con su espera, otro 4xx, o no se llegó a conectar) quitan el "enviando"; el 403 por texto
 *    repetido, un 5xx, un corte o una respuesta sin el id son `OUTCOME_UNKNOWN` y la publicación
 *    queda `outcome_unknown`, sin reenviar;
 * 4. devuelve el id del post (`external_id`, el mismo que lee `parseXPostUrl` del enlace) y su
 *    enlace `https://x.com/<usuario>/status/<id>`.
 * Ningún error, nota ni progreso lleva un token.
 */
export function createXPublisher(options: XPublisherOptions = {}): DirectPublisher {
  let api = options.api;
  const download = options.download ?? downloadXMedia;
  const openVideo = options.openVideo ?? openXVideo;
  const now = options.now ?? (() => new Date());

  /** Sube los medios del post (o reutiliza los del progreso) y deja el progreso con sus ids. */
  const ensureMedia = async (
    input: PublishInput,
    ctx: PublishContext,
    token: { current: string; renew: (call: string) => Promise<string> },
  ): Promise<{ ids: string[]; progress: unknown }> => {
    if (input.media.length === 0) return { ids: [], progress: ctx.progress };
    const saved = xProgressSchema.safeParse(ctx.progress ?? {});
    const previous = saved.success ? saved.data.xMedia : undefined;
    const sameMedia =
      previous !== undefined &&
      previous.items.length === input.media.length &&
      previous.items.every((item, index) => item.mediaId === input.media[index]?.mediaId) &&
      new Date(previous.expiresAt).getTime() - now().getTime() > X_MEDIA_REUSE_MARGIN_MS;
    if (sameMedia && previous !== undefined) {
      options.onNote?.({
        publicationId: input.publicationId,
        kind: "media_uploaded",
        count: previous.items.length,
        reused: true,
      });
      return { ids: previous.items.map((item) => item.xMediaId), progress: ctx.progress };
    }
    api ??= createXApi();
    const client = api;
    const signal = ctx.signal === undefined ? {} : { signal: ctx.signal };
    const items: XMediaProgress["items"] = [];
    const expirations: number[] = [];
    for (const item of input.media) {
      // La imagen (hasta 5 MB) se baja una vez; el video se lee de R2 mientras sube, y un reintento
      // tras un 401 lo vuelve a abrir (el flujo ya se consumió).
      const image =
        item.kind === "video"
          ? null
          : { mediaId: item.mediaId, mime: item.mime, bytes: await download(item, signal) };
      const upload = async (accessToken: string) =>
        image === null
          ? client.uploadVideo(accessToken, await openVideo(item, signal), signal)
          : client.uploadImage(accessToken, image, signal);
      let uploaded: Awaited<ReturnType<typeof upload>>;
      try {
        uploaded = await upload(token.current);
      } catch (error) {
        if (!isUnauthorized(error)) throw error;
        uploaded = await upload(await token.renew("mediaUpload"));
      }
      items.push({ mediaId: item.mediaId, xMediaId: uploaded.id });
      expirations.push(uploaded.expiresAt.getTime());
    }
    const progress = {
      ...ownPart(ctx.progress),
      // El que vence primero manda: un reintento reutiliza todos o ninguno.
      xMedia: {
        items,
        expiresAt: new Date(Math.min(...expirations)).toISOString(),
      } satisfies XMediaProgress,
    };
    await ctx.saveProgress(progress);
    options.onNote?.({
      publicationId: input.publicationId,
      kind: "media_uploaded",
      count: items.length,
      reused: false,
    });
    return { ids: items.map((item) => item.xMediaId), progress };
  };

  const publisher: DirectPublisher = {
    platform: "x",
    formats: ["post"],
    validate: validateXInput,
    // Sin red (X no tiene un "validar" que no publique): en `dry-run`, deja en la bitácora el costo
    // estimado que tendría.
    async preflight(input) {
      const validation = validateXInput(input);
      if (!validation.ok) return validation;
      return { ok: true, notes: [xCostNote(input.caption)] };
    },
    async publish(input, ctx) {
      checkPublishInput(publisher, input);
      if (ctx.signal?.aborted) throw X_ERRORS.aborted();
      // Con un envío anterior (dudoso o ya hecho), `sendOnce` decide sin llamar: ni token ni medios.
      if (pendingSend(ctx.progress).kind !== "none") {
        const sent = await sendOnce(ctx, {
          notSent: isXNotSent,
          send: () => Promise.reject(X_ERRORS.unexpectedResponse("createPost")),
        });
        return { ...sent, simulated: false };
      }
      const provider: AccessTokenProvider = ctx.accessToken ?? platformContextOf(ctx).accessToken;
      const signal = ctx.signal === undefined ? {} : { signal: ctx.signal };
      /** Los errores al renovar tras un 401: prueban que el post no se creó. */
      const renewFailures = new Set<unknown>();
      const token = {
        current: await provider(signal),
        // Después de un 401: un token nuevo, una vez. Si no se puede, no salió nada.
        renew: async (call: string) => {
          try {
            token.current = await provider({ ...signal, rejectedToken: token.current });
          } catch (error) {
            // El 401 ya probó que no salió nada: el error de renovar es "no enviado".
            // Solo un refresh token rechazado pide reconectar; lo demás (la red, un 5xx, un 429,
            // el candado ocupado) sube tal cual, con su `retriable`.
            const failure =
              isAppError(error) && error.code === "TOKEN_REFRESH_REJECTED"
                ? X_ERRORS.authInvalidAfterRefresh()
                : error;
            renewFailures.add(failure);
            throw failure;
          }
          options.onNote?.({
            publicationId: input.publicationId,
            kind: "token_renewed_after_401",
            call,
          });
          return token.current;
        },
      };
      const media = await ensureMedia(input, ctx, token);
      api ??= createXApi();
      const client = api;
      const username = usernameOf(ctx);
      const sent = await sendOnce(ctx, {
        progress: media.progress,
        notSent: (error) => isXNotSent(error) || renewFailures.has(error),
        send: async () => {
          const post = { text: input.caption, mediaIds: media.ids };
          let created: { id: string };
          try {
            created = await client.createPost(token.current, post, signal);
          } catch (error) {
            if (!isUnauthorized(error)) throw error;
            created = await client.createPost(await token.renew("createPost"), post, signal);
          }
          return { externalId: created.id, externalUrl: xPostUrl(created.id, username) };
        },
      });
      return { ...sent, simulated: false };
    },
  };
  return publisher;
}

/** El id de un post de X (`external_id`: el que devuelve publicar o el que lee `parseXPostUrl`). */
const X_POST_ID = /^\d{1,30}$/;

/**
 * Borra un post de X (`DELETE /2/tweets/{id}`, `x.md` §4.3; F9.5-T09): idempotente (un 404 cuenta
 * como borrado). Solo un post del usuario del token; un hilo no existe (F9 no publica hilos). Un id
 * que no es de un post de X es `RETIRE_DELETE_UNSUPPORTED` sin llamar: se borra a mano.
 */
export async function deleteXPost({
  api = createXApi(),
  accessToken,
  postId,
  signal,
}: {
  api?: XApiClient;
  accessToken: string;
  postId: string;
  signal?: AbortSignalLike;
}): Promise<void> {
  if (!X_POST_ID.test(postId)) throw xDeleteUnsupported();
  await api.deletePost(accessToken, postId, signal === undefined ? {} : { signal });
}

const xDeleteUnsupported = () =>
  new AppError(
    "RETIRE_DELETE_UNSUPPORTED",
    "Esta publicación de X no tiene el id del post que acepta la API: bórrala a mano en X",
  );

/**
 * Lo que la API hace con lo publicado en X (F9.5-T09): borrar un post al retirarlo
 * (`retirePublication` con `deleteRemote`). El token es `ctx.accessToken`, que en X asegura
 * `ensureRotatingAccessToken` bajo el candado de credenciales; un 401 pide otro (`rejectedToken`) y
 * repite **una** vez (borrar es idempotente). **Sin envolver**: core decide antes el modo (nunca
 * en simulación) y que la cuenta esté en modo `api`. El costo de borrar no se anota (no está
 * verificado, `x.md` §2.1).
 */
export function createXOperations({
  api = createXApi(),
}: {
  api?: XApiClient;
} = {}): Required<Pick<PublicationOperations, "remove">> {
  return {
    async remove(ref, ctx) {
      if (!X_POST_ID.test(ref.externalId)) throw xDeleteUnsupported();
      const signal = ctx.signal === undefined ? {} : { signal: ctx.signal };
      const accessToken = await ctx.accessToken(signal);
      try {
        await deleteXPost({ api, accessToken, postId: ref.externalId, ...signal });
      } catch (error) {
        if (!isUnauthorized(error)) throw error;
        const renewed = await ctx.accessToken({ ...signal, rejectedToken: accessToken });
        await deleteXPost({ api, accessToken: renewed, postId: ref.externalId, ...signal });
      }
    },
  };
}
