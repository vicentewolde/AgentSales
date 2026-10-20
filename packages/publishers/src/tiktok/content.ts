import { z } from "zod";
import {
  TIKTOK_API_ORIGIN,
  TIKTOK_CHUNK_BYTES,
  TIKTOK_CHUNK_TIMEOUT_MS,
  TIKTOK_PATHS,
  TIKTOK_REQUEST_TIMEOUT_MS,
} from "./constants.js";
import { TIKTOK_ERRORS, tiktokFetchFailure } from "./errors.js";
import { parseTikTokBody, type TikTokCallOptions, tiktokRequest } from "./http.js";

/** Cómo se parte un video para `FILE_UPLOAD` (`tiktok.md` §5). */
export type ChunkPlan = {
  videoSize: number;
  chunkSize: number;
  totalChunks: number;
};

/** Un trozo: sus bytes, del primero al último (inclusive). */
export type ChunkRange = { index: number; first: number; last: number };

/**
 * El plan de trozos de un video (`tiktok.md` §5): `floor(tamaño / trozo)` trozos de `chunkBytes`,
 * y el último se lleva el resto. Si eso da uno solo (un video de menos de `2 × chunkBytes`; la doc
 * exige uno solo bajo 5 MB), su `chunk_size` es el tamaño del video.
 */
export function chunkPlan(videoSize: number, chunkBytes = TIKTOK_CHUNK_BYTES): ChunkPlan {
  const totalChunks = Math.max(1, Math.floor(videoSize / chunkBytes));
  // Un solo trozo (hasta `2 × chunkBytes - 1`, lejos de los 64 MB de un trozo): el `PUT` lleva el
  // video entero, así que `chunk_size` es el tamaño del video, no el del trozo.
  if (totalChunks === 1) return { videoSize, chunkSize: videoSize, totalChunks: 1 };
  return { videoSize, chunkSize: chunkBytes, totalChunks };
}

/** Los trozos del plan, en orden (el último hasta el final del video). */
export function chunkRanges(plan: ChunkPlan): ChunkRange[] {
  return Array.from({ length: plan.totalChunks }, (_, index) => ({
    index,
    first: index * plan.chunkSize,
    last: index === plan.totalChunks - 1 ? plan.videoSize - 1 : (index + 1) * plan.chunkSize - 1,
  }));
}

/** Lo que dice TikTok de un envío (`/v2/post/publish/status/fetch/`). */
export type PublishStatus = {
  /** `PROCESSING_UPLOAD`, `PROCESSING_DOWNLOAD`, `SEND_TO_USER_INBOX`, `PUBLISH_COMPLETE` o `FAILED`. */
  status: string;
  /** Solo con `FAILED` (por ejemplo `file_format_check_failed`). */
  failReason: string | null;
};

/** Lo que entrega el init: el id del envío y la URL de subida (un secreto de 1 h). */
export type InboxVideoInit = { publishId: string; uploadUrl: string };

export type TikTokContentClient = {
  /** `POST /v2/post/publish/inbox/video/init/` con `FILE_UPLOAD` (modo *Upload*, la bandeja). */
  initInboxVideo(
    accessToken: string,
    plan: ChunkPlan,
    options?: TikTokCallOptions,
  ): Promise<InboxVideoInit>;
  /** Un `PUT` del trozo a la URL de subida, con su `Content-Range`. */
  uploadChunk(
    uploadUrl: string,
    chunk: { range: ChunkRange; videoSize: number; mime: string; bytes: Uint8Array },
    options?: TikTokCallOptions,
  ): Promise<void>;
  status(
    accessToken: string,
    publishId: string,
    options?: TikTokCallOptions,
  ): Promise<PublishStatus>;
};

export type TikTokContentOptions = {
  origin?: string;
  timeoutMs?: number;
  chunkTimeoutMs?: number;
};

const initResponseSchema = z.object({
  data: z.object({
    publish_id: z.string().regex(/^[\w.~-]{1,200}$/),
    upload_url: z.url({ protocol: /^https$/ }),
  }),
});

const statusResponseSchema = z.object({
  data: z.object({
    status: z.string().regex(/^[A-Z_]{1,60}$/),
    fail_reason: z
      .string()
      .regex(/^[\w.]{0,80}$/)
      .nullish()
      .catch(null),
  }),
});

/**
 * El cliente de Content Posting en modo *Upload* (spec F9 §4.6, D16; `tiktok.md` §2, §5 y §6). No
 * decide nada: el publisher lo usa en orden (init, los trozos en orden, el estado). Ningún error
 * lleva el token, la URL de subida ni los bytes; no escribe logs.
 */
export function createTikTokContent(options: TikTokContentOptions = {}): TikTokContentClient {
  const origin = options.origin ?? TIKTOK_API_ORIGIN;
  const timeoutMs = options.timeoutMs ?? TIKTOK_REQUEST_TIMEOUT_MS;
  const chunkTimeoutMs = options.chunkTimeoutMs ?? TIKTOK_CHUNK_TIMEOUT_MS;
  return {
    async initInboxVideo(accessToken, plan, { signal } = {}) {
      const body = await tiktokRequest(
        "initInboxVideo",
        new URL(TIKTOK_PATHS.inboxVideoInit, origin),
        {
          method: "POST",
          style: "api",
          accessToken,
          json: {
            source_info: {
              source: "FILE_UPLOAD",
              video_size: plan.videoSize,
              chunk_size: plan.chunkSize,
              total_chunk_count: plan.totalChunks,
            },
          },
        },
        { signal, timeoutMs },
      );
      const { data } = parseTikTokBody("initInboxVideo", initResponseSchema, body);
      return { publishId: data.publish_id, uploadUrl: data.upload_url };
    },

    async uploadChunk(uploadUrl, { range, videoSize, mime, bytes }, { signal } = {}) {
      if (signal?.aborted) throw TIKTOK_ERRORS.aborted();
      const caller = new AbortController();
      const onAbort = () => caller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = AbortSignal.timeout(chunkTimeoutMs);
      try {
        let response: Response;
        try {
          response = await fetch(uploadUrl, {
            method: "PUT",
            headers: {
              "content-type": mime,
              "content-length": String(bytes.byteLength),
              "content-range": `bytes ${range.first}-${range.last}/${videoSize}`,
            },
            body: bytes,
            redirect: "error",
            signal: AbortSignal.any([caller.signal, timeout]),
          });
        } catch (caught) {
          throw tiktokFetchFailure("uploadChunk", caught, {
            aborted: caller.signal.aborted,
            timedOut: timeout.aborted,
          });
        }
        // El cuerpo no importa (206 con trozos pendientes, 201 al completar): se descarta.
        await response.arrayBuffer().catch(() => undefined);
        if (response.ok) return;
        if (response.status >= 500) {
          throw TIKTOK_ERRORS.unavailable("uploadChunk", "server", response.status);
        }
        throw TIKTOK_ERRORS.uploadRejected(response.status, range.index);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },

    async status(accessToken, publishId, { signal } = {}) {
      const body = await tiktokRequest(
        "status",
        new URL(TIKTOK_PATHS.status, origin),
        { method: "POST", style: "api", accessToken, json: { publish_id: publishId } },
        { signal, timeoutMs },
      );
      const { data } = parseTikTokBody("status", statusResponseSchema, body);
      return { status: data.status, failReason: data.fail_reason ?? null };
    },
  };
}
