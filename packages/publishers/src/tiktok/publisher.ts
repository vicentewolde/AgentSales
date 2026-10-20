import {
  type AbortSignalLike,
  AppError,
  checkPublishInput,
  isAppError,
  outcomeUnknown,
  type PublishContext,
  type Publisher,
  type PublishHandoff,
  type PublishInput,
  type PublishIssue,
  type PublishMediaItem,
  type PublishValidation,
  platformContextOf,
  sendOnce,
} from "@agentsales/core";
import {
  TIKTOK_CHUNK_BYTES,
  TIKTOK_CHUNK_TIMEOUT_MS,
  TIKTOK_LIMITS,
  TIKTOK_STATUS_POLL,
  TIKTOK_VIDEO_MIMES,
} from "./constants.js";
import {
  type ChunkRange,
  chunkPlan,
  chunkRanges,
  createTikTokContent,
  type PublishStatus,
  type TikTokContentClient,
} from "./content.js";
import { isTikTokTokenRejected, TIKTOK_ERRORS } from "./errors.js";

/** Un hecho del intento (sin la publicación). */
export type TikTokPublishEvent =
  | { kind: "token_rejected_retry"; call: string }
  | { kind: "uploaded"; publishId: string; chunks: number; bytes: number }
  | { kind: "status"; publishId: string; status: string; checks: number };

/** Lo que pasa en un intento y va al log del worker: solo ids, códigos y cifras. */
export type TikTokPublishNote = { publicationId: string } & TikTokPublishEvent;

export type TikTokPublisherOptions = {
  /** Por defecto `createTikTokContent()`. */
  content?: TikTokContentClient;
  /**
   * Lee un trozo del video de R2 por su URL firmada (de 1 hora, recién creada en el intento), con
   * `Range`: así nunca está el video entero en memoria. Por defecto con `fetch`. Nunca pone la URL
   * en un error.
   */
  readChunk?: (
    item: PublishMediaItem,
    range: ChunkRange,
    options: { signal?: AbortSignalLike },
  ) => Promise<Uint8Array>;
  /** El tamaño de los trozos (para los tests); por defecto `TIKTOK_CHUNK_BYTES`. */
  chunkBytes?: number;
  /** Las esperas entre consultas del estado (para los tests). */
  pollDelaysMs?: readonly number[];
  sleep?: (ms: number, signal?: AbortSignalLike) => Promise<void>;
  onNote?: (note: TikTokPublishNote) => void;
};

/** La nota (bitácora) del traspaso: el borrador llegó a la bandeja y el operador lo termina. */
export const TIKTOK_INBOX_NOTE =
  "El video quedó como borrador en la bandeja de TikTok: ábrelo en la app (llega una notificación), pega el texto que está en AgentSales, publícalo y confirma con el enlace del video";

/** Los estados que dicen que el borrador llegó (o que el operador ya lo publicó). */
const DELIVERED: ReadonlySet<string> = new Set(["SEND_TO_USER_INBOX", "PUBLISH_COMPLETE"]);

/** Los motivos de `FAILED` que un reintento puede arreglar (`tiktok.md` §6). */
const RETRIABLE_FAIL_REASONS: ReadonlySet<string> = new Set(["internal", "video_pull_failed"]);

/**
 * Los errores del **último** trozo que prueban que TikTok no lo recibió completo: lo rechazó (4xx)
 * o no se llegó a conectar. Un 5xx, un corte o un tope ahí son dudosos: el video pudo quedar
 * completo y llegar a la bandeja.
 */
const FINAL_CHUNK_NOT_SENT: ReadonlySet<string> = new Set([
  "TIKTOK_UPLOAD_REJECTED",
  "TIKTOK_UNREACHABLE",
]);

/** El video del input: el único medio, si es un video. */
export function tiktokVideoOf(input: Pick<PublishInput, "media">): PublishMediaItem | null {
  const [only, ...rest] = input.media;
  return only !== undefined && rest.length === 0 && only.kind === "video" ? only : null;
}

/**
 * Lo que TikTok no aceptaría (pura, sin red; la usa también `withDryRun`): **solo video** (spec F9
 * §4.6, D16: un post sin video no va a TikTok), uno solo, MP4, MOV o WebM, hasta 4 GB y 10 min; el
 * texto hasta 2.200 caracteres (en modo *Upload* no se envía: lo pega el operador en la app).
 */
export function validateTikTokInput(input: PublishInput): PublishValidation {
  const issues: PublishIssue[] = [];
  const videos = input.media.filter((item) => item.kind === "video");
  if (videos.length === 0) {
    issues.push({
      code: "TIKTOK_VIDEO_REQUIRED",
      message: "TikTok publica solo video: el post necesita un video",
    });
  } else if (input.media.length > 1) {
    issues.push({
      code: "TIKTOK_ONE_VIDEO_ONLY",
      message: "A TikTok va un solo video, sin imágenes",
    });
  }
  const video = tiktokVideoOf(input);
  if (video !== null) {
    if (!TIKTOK_VIDEO_MIMES.has(video.mime)) {
      issues.push({
        code: "TIKTOK_VIDEO_FORMAT",
        message: "TikTok acepta videos MP4, MOV o WebM",
      });
    }
    if (video.bytes <= 0 || video.bytes > TIKTOK_LIMITS.videoBytes) {
      issues.push({
        code: "TIKTOK_VIDEO_TOO_LARGE",
        message: "El video pesa más de los 4 GB que acepta TikTok",
      });
    }
    if (video.durationS !== null && video.durationS > TIKTOK_LIMITS.videoSeconds) {
      issues.push({
        code: "TIKTOK_VIDEO_TOO_LONG",
        message: "El video dura más de los 10 minutos que acepta TikTok",
      });
    }
  }
  if (input.caption.length > TIKTOK_LIMITS.captionChars) {
    issues.push({
      code: "TIKTOK_TEXT_TOO_LONG",
      message: `El texto pasa de los ${TIKTOK_LIMITS.captionChars.toLocaleString("es-CL")} caracteres de TikTok`,
    });
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * Lee un trozo del video de R2 con `Range`, con tope de tiempo. Exige la respuesta parcial exacta
 * (206 con el largo del trozo; un 200 solo si el trozo es el video entero). Ningún error lleva la
 * URL: `TIKTOK_MEDIA_UNAVAILABLE` (reintentable).
 */
export async function readChunkFromStorage(
  item: PublishMediaItem,
  range: ChunkRange,
  { signal }: { signal?: AbortSignalLike } = {},
): Promise<Uint8Array> {
  if (signal?.aborted) throw TIKTOK_ERRORS.aborted();
  const caller = new AbortController();
  const onAbort = () => caller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = AbortSignal.timeout(TIKTOK_CHUNK_TIMEOUT_MS);
  const expected = range.last - range.first + 1;
  try {
    let response: Response;
    try {
      response = await fetch(item.url, {
        headers: { range: `bytes=${range.first}-${range.last}` },
        redirect: "error",
        signal: AbortSignal.any([caller.signal, timeout]),
      });
    } catch {
      if (caller.signal.aborted) throw TIKTOK_ERRORS.aborted();
      throw TIKTOK_ERRORS.mediaUnavailable(item.mediaId, timeout.aborted ? "timeout" : "network");
    }
    const whole = range.first === 0 && expected === item.bytes;
    if (response.status !== 206 && !(response.status === 200 && whole)) {
      await response.arrayBuffer().catch(() => undefined);
      throw TIKTOK_ERRORS.mediaUnavailable(
        item.mediaId,
        response.ok ? "range_ignored" : `http_${response.status}`,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      if (caller.signal.aborted) throw TIKTOK_ERRORS.aborted();
      throw TIKTOK_ERRORS.mediaUnavailable(item.mediaId, "network");
    }
    if (bytes.byteLength !== expected) throw TIKTOK_ERRORS.mediaUnavailable(item.mediaId, "size");
    return bytes;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Espera `ms` o corta con la señal (`TIKTOK_ABORTED`). */
function abortableSleep(ms: number, signal?: AbortSignalLike): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(TIKTOK_ERRORS.aborted());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(TIKTOK_ERRORS.aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** `FAILED` (`TIKTOK_UPLOAD_FAILED`, o `TIKTOK_AUTH_INVALID` si el usuario quitó el acceso). */
function failedError(publishId: string, failReason: string | null): AppError {
  if (failReason === "auth_removed") {
    return new AppError(
      "TIKTOK_AUTH_INVALID",
      "La cuenta quitó el acceso de la app en TikTok: reconéctala",
      { details: { publishId, failReason, reason: "auth_removed" } },
    );
  }
  return new AppError(
    "TIKTOK_UPLOAD_FAILED",
    `TikTok no aceptó el video (${failReason ?? "sin motivo"})`,
    {
      retriable: failReason !== null && RETRIABLE_FAIL_REASONS.has(failReason),
      details: { publishId, failReason },
    },
  );
}

/**
 * Publisher de TikTok en modo *Upload*: el video va como **borrador** a la bandeja del creador
 * (spec F9 §4.6, D16; F9-T26; `tiktok.md` §2, §5 y §6). Tiene paso manual (`manualConfirm`): nunca
 * da por publicado; el operador termina el post en la app (pega el texto, que en este modo no se
 * envía) y confirma con el enlace (`parseTikTokVideoUrl` de core). En `dry-run` no se llama
 * (`withDryRun` simula el traspaso sin red). Un intento:
 * 1. revisa el input (`validateTikTokInput`: solo un video);
 * 2. **sube una vez** con `sendOnce` (ADR-0029 punto 8): init (`FILE_UPLOAD`, con el token de
 *    `ctx.accessToken`, que renueva `ensureRotatingAccessToken`; un `access_token_invalid` pide otro
 *    una vez) y los trozos **en orden**, cada uno leído de R2 con `Range` justo antes de subirlo.
 *    El "no enviado" es estricto: hasta el último trozo, nada llega a la bandeja (el video está
 *    incompleto), así que cualquier error quita el "enviando" y sube tal cual (el tope de 5
 *    pendientes, `TIKTOK_PENDING_LIMIT`, trae `waitMinutes` y core reprograma); en el último, solo
 *    un rechazo (4xx) o no haber conectado; un 5xx, un corte o un tope ahí son `OUTCOME_UNKNOWN`.
 *    El resultado guardado es el `publish_id` (`send.result.externalId`): un reintento no sube de
 *    nuevo, solo vuelve a mirar el estado;
 * 3. consulta el estado (sin webhooks) con esperas crecientes: `SEND_TO_USER_INBOX` (o
 *    `PUBLISH_COMPLETE`) devuelve el traspaso (`awaiting_manual_confirm`); `FAILED` borra el
 *    progreso (no llegó nada: el reintento sube desde cero) y es `TIKTOK_UPLOAD_FAILED`; si sigue
 *    procesando, `TIKTOK_STILL_PROCESSING` (reintentable, `waitMinutes`). Una consulta que TikTok
 *    rechaza deja la publicación dudosa (`OUTCOME_UNKNOWN`): el video subió completo.
 * Ningún error, nota ni progreso lleva un token, la URL de subida ni la de R2.
 */
export function createTikTokPublisher(options: TikTokPublisherOptions = {}): Publisher {
  let content = options.content;
  const readChunk = options.readChunk ?? readChunkFromStorage;
  const chunkBytes = options.chunkBytes ?? TIKTOK_CHUNK_BYTES;
  const delays = options.pollDelaysMs ?? TIKTOK_STATUS_POLL.delaysMs;
  const sleep = options.sleep ?? abortableSleep;

  const publisher: Publisher = {
    platform: "tiktok",
    formats: ["post"],
    manualConfirm: true,
    validate: validateTikTokInput,
    async publish(input, ctx: PublishContext): Promise<PublishHandoff> {
      checkPublishInput(publisher, input);
      if (ctx.signal?.aborted) throw TIKTOK_ERRORS.aborted();
      const video = tiktokVideoOf(input);
      if (video === null) throw TIKTOK_ERRORS.unexpectedResponse("input");
      content ??= createTikTokContent();
      const client = content;
      const signalOptions = ctx.signal === undefined ? {} : { signal: ctx.signal };
      const tokens = platformContextOf(ctx).accessToken;
      const note = (event: TikTokPublishEvent) =>
        options.onNote?.({ publicationId: input.publicationId, ...event });

      /** Una llamada con el token del intento; si TikTok lo rechaza, pide otro y repite una vez. */
      const withToken = async <T>(call: string, fn: (token: string) => Promise<T>): Promise<T> => {
        const token = await tokens(signalOptions);
        try {
          return await fn(token);
        } catch (caught) {
          if (!isTikTokTokenRejected(caught)) throw caught;
          note({ kind: "token_rejected_retry", call });
          return fn(await tokens({ ...signalOptions, rejectedToken: token }));
        }
      };

      const plan = chunkPlan(video.bytes, chunkBytes);
      let finalChunkStarted = false;
      const sent = await sendOnce(ctx, {
        notSent: (caught) =>
          !finalChunkStarted || (isAppError(caught) && FINAL_CHUNK_NOT_SENT.has(caught.code)),
        send: async () => {
          const init = await withToken("initInboxVideo", (token) =>
            client.initInboxVideo(token, plan, signalOptions),
          );
          for (const range of chunkRanges(plan)) {
            const bytes = await readChunk(video, range, signalOptions);
            if (range.index === plan.totalChunks - 1) finalChunkStarted = true;
            await client.uploadChunk(
              init.uploadUrl,
              { range, videoSize: plan.videoSize, mime: video.mime, bytes },
              signalOptions,
            );
          }
          note({
            kind: "uploaded",
            publishId: init.publishId,
            chunks: plan.totalChunks,
            bytes: plan.videoSize,
          });
          return { externalId: init.publishId, externalUrl: null };
        },
      });
      const publishId = sent.externalId;

      let last: PublishStatus | null = null;
      let checks = 0;
      for (const delay of delays) {
        await sleep(delay, ctx.signal);
        try {
          last = await withToken("status", (token) =>
            client.status(token, publishId, signalOptions),
          );
        } catch (caught) {
          // La red, un tope o un 5xx: el reintento vuelve a mirar sin subir. Un rechazo de TikTok
          // (que no sea el acceso) deja dudoso lo que ya subió completo.
          if (!isAppError(caught) || caught.retriable || caught.code === "TIKTOK_AUTH_INVALID") {
            throw caught;
          }
          throw outcomeUnknown("send_failed", caught);
        }
        checks += 1;
        if (DELIVERED.has(last.status) || last.status === "FAILED") break;
      }
      note({ kind: "status", publishId, status: last?.status ?? "NONE", checks });

      if (last !== null && DELIVERED.has(last.status)) {
        return { handoff: "manual_confirm", simulated: false, notes: [TIKTOK_INBOX_NOTE] };
      }
      if (last?.status === "FAILED") {
        // No llegó nada a la bandeja: sin el "enviando", el reintento sube desde cero. Si no se
        // puede borrar, el reintento vuelve a ver FAILED y lo intenta de nuevo.
        await ctx.saveProgress(null).catch(() => undefined);
        throw failedError(publishId, last.failReason);
      }
      throw new AppError(
        "TIKTOK_STILL_PROCESSING",
        "TikTok sigue procesando el video: se vuelve a mirar en unos minutos, sin subirlo de nuevo",
        {
          retriable: true,
          details: {
            publishId,
            status: last?.status ?? null,
            waitMinutes: TIKTOK_STATUS_POLL.retryMinutes,
          },
        },
      );
    },
  };
  return publisher;
}
