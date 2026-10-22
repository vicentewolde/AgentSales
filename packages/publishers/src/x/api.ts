import { type AbortSignalLike, isAppError } from "@agentsales/core";
import { z } from "zod";
import {
  X_API_ORIGIN,
  X_LIMITS,
  X_MEDIA_PROCESSING_MAX_MS,
  X_REQUEST_TIMEOUT_MS,
  X_UPLOAD_TIMEOUT_MS,
} from "./constants.js";
import { X_ERRORS } from "./errors.js";
import { type XCallOptions, xRequest } from "./http.js";

// La API de X para publicar (spec F9 §4.6, F9-T16; `x.md` §4.1 y §5.1): crear un post y subir sus
// medios con la API v2 (`/2/media/upload`; el video, por partes); desde F9.5-T09, borrar un post
// al retirarlo (`x.md` §4.3). Siempre con el token de usuario de OAuth 2.0 (`Bearer`). Ningún error
// lleva el token, el texto ni los bytes.

/** Una imagen ya en memoria (se bajó de R2 antes de subirla; hasta 5 MB). */
export type XUploadFile = { mediaId: string; mime: string; bytes: Uint8Array };

/**
 * Un video que se lee mientras se sube (F9.5-T08): los trozos llegan de R2 en el tamaño que sea y
 * `uploadVideo` los junta en partes de 4 MB, sin tener nunca el archivo entero en memoria.
 * `totalBytes` es el tamaño anunciado (el `content-length` de R2): X lo pide en el INIT, y lo leído
 * tiene que coincidir. Si la subida falla antes de terminar, `uploadVideo` cierra el flujo.
 */
export type XUploadStream = {
  mediaId: string;
  mime: string;
  totalBytes: number;
  chunks: AsyncIterable<Uint8Array>;
};

/** Un medio subido: su id en X y cuándo vence (`expires_after_secs`; sin el dato, 24 h). */
export type XUploadedMedia = { id: string; expiresAt: Date };

/**
 * Cliente de la API de X. `createPost` publica **una** vez (sin idempotencia en X: no se repite
 * solo; el publisher lo envuelve en `sendOnce`). Las subidas no publican nada.
 */
export interface XApiClient {
  createPost(
    accessToken: string,
    post: { text: string; mediaIds: readonly string[] },
    options?: XCallOptions,
  ): Promise<{ id: string }>;
  uploadImage(
    accessToken: string,
    file: XUploadFile,
    options?: XCallOptions,
  ): Promise<XUploadedMedia>;
  /**
   * INIT con el tamaño anunciado, APPEND de cada parte de 4 MB a medida que llega del flujo,
   * FINALIZE y, si X lo procesa, STATUS hasta `succeeded`. Un flujo que entrega más o menos bytes
   * que `totalBytes` es `X_MEDIA_UNAVAILABLE` (`size`) antes del FINALIZE.
   */
  uploadVideo(
    accessToken: string,
    file: XUploadStream,
    options?: XCallOptions,
  ): Promise<XUploadedMedia>;
  /**
   * F9.5-T09: `DELETE /2/tweets/:id` (`x.md` §4.3), solo un post del usuario del token. Idempotente:
   * un 404 (ya no existe) cuenta como borrado. Un 2xx que no dice `deleted: true` es
   * `X_UNEXPECTED_RESPONSE` (no se da por borrado). El costo no está verificado (`x.md` §2.1).
   */
  deletePost(accessToken: string, postId: string, options?: XCallOptions): Promise<void>;
}

export type XApiOptions = {
  /** Por defecto `https://api.x.com`. */
  origin?: string;
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  /** Cuánto se espera, como mucho, a que X procese un video. */
  processingMaxMs?: number;
  /** La espera entre consultas del estado (para los tests). */
  sleep?: (ms: number, signal?: AbortSignalLike) => Promise<void>;
  now?: () => Date;
};

const idSchema = z
  .union([z.string().regex(/^\d{1,30}$/), z.number().int().nonnegative()])
  .transform(String);

const createPostSchema = z.looseObject({ data: z.looseObject({ id: idSchema }) });

const deletePostSchema = z.looseObject({ data: z.looseObject({ deleted: z.literal(true) }) });

/** Si un error es el 404 de X: lo que se quería borrar ya no existe. */
const isNotFound = (error: unknown) =>
  isAppError(error) && (error.details as { httpStatus?: unknown } | undefined)?.httpStatus === 404;

const processingSchema = z
  .looseObject({
    state: z.string(),
    check_after_secs: z.number().nonnegative().nullish(),
    error: z.looseObject({ name: z.string().nullish(), message: z.string().nullish() }).nullish(),
  })
  .nullish();

const mediaSchema = z.looseObject({
  data: z.looseObject({
    id: idSchema,
    expires_after_secs: z.number().int().positive().nullish(),
    processing_info: processingSchema,
  }),
});

/** Sin `expires_after_secs`, un medio subido vale 24 h (`x.md` §5.1). */
const DEFAULT_MEDIA_TTL_S = 24 * 60 * 60;

/** Espera `ms` o corta con la señal (`X_ABORTED`). */
export function abortableSleep(ms: number, signal?: AbortSignalLike): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(X_ERRORS.aborted());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(X_ERRORS.aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const blobOf = (bytes: Uint8Array, mime: string) =>
  new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime });

/**
 * Junta los trozos de un flujo en partes de `partBytes` (la última, la que quede) y revisa que
 * sumen exactamente `totalBytes`: uno de más falla apenas llega, uno de menos al terminar. En
 * memoria hay a lo más una parte y el trozo que se está copiando.
 */
export async function* partsOf(
  chunks: AsyncIterable<Uint8Array>,
  { totalBytes, partBytes, mediaId }: { totalBytes: number; partBytes: number; mediaId: string },
): AsyncGenerator<Uint8Array> {
  let read = 0;
  let part = new Uint8Array(Math.min(partBytes, totalBytes));
  let filled = 0;
  for await (const chunk of chunks) {
    read += chunk.byteLength;
    if (read > totalBytes) throw X_ERRORS.mediaUnavailable(mediaId, "size");
    let offset = 0;
    while (offset < chunk.byteLength) {
      const take = Math.min(part.byteLength - filled, chunk.byteLength - offset);
      part.set(chunk.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === part.byteLength) {
        yield part;
        part = new Uint8Array(Math.min(partBytes, totalBytes - read + (chunk.byteLength - offset)));
        filled = 0;
      }
    }
  }
  if (read !== totalBytes) throw X_ERRORS.mediaUnavailable(mediaId, "size");
}

export function createXApi(options: XApiOptions = {}): XApiClient {
  const origin = options.origin ?? X_API_ORIGIN;
  const timeoutMs = options.timeoutMs ?? X_REQUEST_TIMEOUT_MS;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? X_UPLOAD_TIMEOUT_MS;
  const processingMaxMs = options.processingMaxMs ?? X_MEDIA_PROCESSING_MAX_MS;
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? (() => new Date());
  const bearer = (token: string) => `Bearer ${token}`;
  const call = (signal: AbortSignalLike | undefined, ms: number) => ({
    ...(signal === undefined ? {} : { signal }),
    timeoutMs: ms,
    now,
  });

  const uploaded = (body: unknown, call: string): z.infer<typeof mediaSchema>["data"] => {
    const parsed = mediaSchema.safeParse(body);
    if (!parsed.success) throw X_ERRORS.unexpectedResponse(call);
    return parsed.data.data;
  };
  const expiry = (data: { expires_after_secs?: number | null | undefined }) =>
    new Date(now().getTime() + (data.expires_after_secs ?? DEFAULT_MEDIA_TTL_S) * 1000);

  /** Consulta el estado hasta `succeeded`; `failed` es `X_MEDIA_REJECTED`; el tope, reintentable. */
  const waitProcessing = async (
    token: string,
    file: Pick<XUploadFile, "mediaId">,
    xMediaId: string,
    first: z.infer<typeof processingSchema>,
    signal: AbortSignalLike | undefined,
  ) => {
    let info = first;
    const deadline = now().getTime() + processingMaxMs;
    while (info != null && info.state !== "succeeded") {
      if (info.state === "failed") {
        throw X_ERRORS.mediaRejected(file.mediaId, info.error?.name ?? null);
      }
      const waitS = Math.min(Math.max(info.check_after_secs ?? 5, 1), 60);
      if (now().getTime() + waitS * 1000 > deadline) {
        throw X_ERRORS.mediaProcessingTimeout(file.mediaId);
      }
      await sleep(waitS * 1000, signal);
      const target = new URL("/2/media/upload", origin);
      target.searchParams.set("command", "STATUS");
      target.searchParams.set("media_id", xMediaId);
      const body = await xRequest(
        "mediaStatus",
        target,
        { method: "GET", authorization: bearer(token) },
        call(signal, timeoutMs),
      );
      info = uploaded(body, "mediaStatus").processing_info;
    }
  };

  return {
    async createPost(token, post, { signal } = {}) {
      const body = await xRequest(
        "createPost",
        new URL("/2/tweets", origin),
        {
          method: "POST",
          authorization: bearer(token),
          body: JSON.stringify({
            text: post.text,
            ...(post.mediaIds.length === 0 ? {} : { media: { media_ids: [...post.mediaIds] } }),
          }),
          contentType: "application/json",
        },
        call(signal, timeoutMs),
      );
      const parsed = createPostSchema.safeParse(body);
      // Un 2xx sin el id: X lo aceptó y no se sabe cuál es (el publisher lo deja dudoso).
      if (!parsed.success) throw X_ERRORS.unexpectedResponse("createPost");
      return { id: parsed.data.data.id };
    },

    async uploadImage(token, file, { signal } = {}) {
      const form = new FormData();
      form.append("media", blobOf(file.bytes, file.mime), "imagen");
      form.append("media_category", file.mime === "image/gif" ? "tweet_gif" : "tweet_image");
      const data = uploaded(
        await xRequest(
          "mediaUpload",
          new URL("/2/media/upload", origin),
          { method: "POST", authorization: bearer(token), body: form, contentType: null },
          call(signal, uploadTimeoutMs),
        ),
        "mediaUpload",
      );
      await waitProcessing(token, file, data.id, data.processing_info, signal);
      return { id: data.id, expiresAt: expiry(data) };
    },

    async uploadVideo(token, file, { signal } = {}) {
      // El flujo se cierra pase lo que pase (un error de X a medio subir deja la descarga abierta).
      const source = file.chunks[Symbol.asyncIterator]();
      const chunks: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => source };
      let init: z.infer<typeof mediaSchema>["data"];
      try {
        if (file.totalBytes <= 0) throw X_ERRORS.mediaUnavailable(file.mediaId, "size");
        init = uploaded(
          await xRequest(
            "mediaInitialize",
            new URL("/2/media/upload/initialize", origin),
            {
              method: "POST",
              authorization: bearer(token),
              body: JSON.stringify({
                media_type: file.mime,
                total_bytes: file.totalBytes,
                media_category: "tweet_video",
              }),
              contentType: "application/json",
            },
            call(signal, timeoutMs),
          ),
          "mediaInitialize",
        );
        let index = 0;
        for await (const part of partsOf(chunks, {
          totalBytes: file.totalBytes,
          partBytes: X_LIMITS.chunkBytes,
          mediaId: file.mediaId,
        })) {
          const form = new FormData();
          form.append("segment_index", String(index));
          form.append("media", blobOf(part, "application/octet-stream"), `trozo-${index}`);
          await xRequest(
            "mediaAppend",
            new URL(`/2/media/upload/${init.id}/append`, origin),
            {
              method: "POST",
              authorization: bearer(token),
              body: form,
              contentType: null,
              allowEmpty: true,
            },
            call(signal, uploadTimeoutMs),
          );
          index += 1;
        }
      } finally {
        await source.return?.();
      }
      const xMediaId = init.id;
      const finalized = uploaded(
        await xRequest(
          "mediaFinalize",
          new URL(`/2/media/upload/${xMediaId}/finalize`, origin),
          { method: "POST", authorization: bearer(token) },
          call(signal, timeoutMs),
        ),
        "mediaFinalize",
      );
      await waitProcessing(token, file, xMediaId, finalized.processing_info, signal);
      return {
        id: xMediaId,
        expiresAt: expiry(finalized.expires_after_secs == null ? init : finalized),
      };
    },

    async deletePost(token, postId, { signal } = {}) {
      let body: unknown;
      try {
        body = await xRequest(
          "deletePost",
          new URL(`/2/tweets/${encodeURIComponent(postId)}`, origin),
          { method: "DELETE", authorization: bearer(token) },
          call(signal, timeoutMs),
        );
      } catch (error) {
        // Borrar es idempotente: uno que ya no existe ya está borrado.
        if (isNotFound(error)) return;
        throw error;
      }
      if (!deletePostSchema.safeParse(body).success) {
        throw X_ERRORS.unexpectedResponse("deletePost");
      }
    },
  };
}
