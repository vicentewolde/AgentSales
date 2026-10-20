import type { AbortSignalLike } from "@agentsales/core";
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
// medios con la API v2 (`/2/media/upload`; el video, por partes). Siempre con el token de usuario
// de OAuth 2.0 (`Bearer`). Ningún error lleva el token, el texto ni los bytes.

/** Un medio ya en memoria (se bajó de R2 antes de subirlo). */
export type XUploadFile = { mediaId: string; mime: string; bytes: Uint8Array };

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
  /** INIT, APPEND en trozos de 4 MB, FINALIZE y, si X lo procesa, STATUS hasta `succeeded`. */
  uploadVideo(
    accessToken: string,
    file: XUploadFile,
    options?: XCallOptions,
  ): Promise<XUploadedMedia>;
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
    file: XUploadFile,
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
      const init = uploaded(
        await xRequest(
          "mediaInitialize",
          new URL("/2/media/upload/initialize", origin),
          {
            method: "POST",
            authorization: bearer(token),
            body: JSON.stringify({
              media_type: file.mime,
              total_bytes: file.bytes.byteLength,
              media_category: "tweet_video",
            }),
            contentType: "application/json",
          },
          call(signal, timeoutMs),
        ),
        "mediaInitialize",
      );
      const xMediaId = init.id;
      for (
        let offset = 0, index = 0;
        offset < file.bytes.byteLength;
        offset += X_LIMITS.chunkBytes, index += 1
      ) {
        const chunk = file.bytes.subarray(offset, offset + X_LIMITS.chunkBytes);
        const form = new FormData();
        form.append("segment_index", String(index));
        form.append("media", blobOf(chunk, "application/octet-stream"), `trozo-${index}`);
        await xRequest(
          "mediaAppend",
          new URL(`/2/media/upload/${xMediaId}/append`, origin),
          {
            method: "POST",
            authorization: bearer(token),
            body: form,
            contentType: null,
            allowEmpty: true,
          },
          call(signal, uploadTimeoutMs),
        );
      }
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
  };
}
