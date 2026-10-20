import {
  type AbortSignalLike,
  AppError,
  checkPublishInput,
  type DirectPublisher,
  escapeLinkedInText,
  isAppError,
  linkedinMemberIdSchema,
  linkedinPersonUrn,
  linkedinPostUrl,
  type PublishContext,
  type PublishInput,
  type PublishIssue,
  type PublishMediaItem,
  type PublishValidation,
  pendingSend,
  platformContextOf,
  sendOnce,
} from "@agentsales/core";
import { z } from "zod";
import { createLinkedInApi, type LinkedInApi, type LinkedInPostContent } from "./api.js";
import {
  LINKEDIN_IMAGE_MIMES,
  LINKEDIN_LIMITS,
  LINKEDIN_UPLOAD_TIMEOUT_MS,
  LINKEDIN_VIDEO_POLL,
} from "./constants.js";
import { isLinkedInNotSent, LINKEDIN_ERRORS } from "./errors.js";

/** Lo que pasa en un intento y va al log del worker: solo ids y cifras, nunca el token ni una URL. */
export type LinkedInPublishNote = { publicationId: string } & (
  | { kind: "media_reused"; count: number }
  | { kind: "video_status_unreadable"; mediaId: string }
  | { kind: "video_still_processing"; mediaId: string; checks: number }
);

/** Un tramo de bytes de un medio (`Range: bytes=first-last`), o `null` para el archivo entero. */
export type MediaRange = { first: number; last: number } | null;

export type LinkedInPublisherOptions = {
  /** Por defecto `createLinkedInApi()`. */
  api?: LinkedInApi;
  /**
   * Lee un medio de R2 por su URL firmada (de 1 hora, recién creada en el intento): entero, o un
   * tramo (las partes de 4 MiB de un video, sin cargarlo entero en memoria). Por defecto con
   * `fetch`. Nunca pone la URL en un error.
   */
  readMedia?: (
    item: PublishMediaItem,
    range: MediaRange,
    options: { signal?: AbortSignalLike | undefined },
  ) => Promise<Uint8Array>;
  /** La espera entre consultas del video (para los tests). */
  sleep?: (ms: number, signal?: AbortSignalLike) => Promise<void>;
  videoPoll?: { intervalMs: number; attempts: number };
  onNote?: (note: LinkedInPublishNote) => void;
};

/**
 * Lo que LinkedIn no aceptaría (pura, sin red; la usa también `withDryRun`): el texto no vacío y,
 * con los escapes del formato "little text", hasta 3.000 caracteres; hasta 20 imágenes JPG, PNG o
 * GIF bajo su tope de píxeles, **o** un video MP4 de 3 s a 30 min y de 75 KB a 500 MB (no se
 * mezclan, `linkedin.md` §4.3 y §5.1).
 */
export function validateLinkedInInput(input: PublishInput): PublishValidation {
  const issues: PublishIssue[] = [];
  if (input.caption.trim() === "") {
    issues.push({
      code: "LINKEDIN_TEXT_EMPTY",
      message: "LinkedIn exige texto en la publicación",
    });
  } else if (escapeLinkedInText(input.caption).length > LINKEDIN_LIMITS.commentaryChars) {
    issues.push({
      code: "LINKEDIN_TEXT_TOO_LONG",
      message: `El texto pasa de los ${LINKEDIN_LIMITS.commentaryChars.toLocaleString("es-CL")} caracteres de LinkedIn (contando los escapes)`,
    });
  }
  const videos = input.media.filter((item) => item.kind === "video");
  const images = input.media.filter((item) => item.kind !== "video");
  if (videos.length > 0 && images.length > 0) {
    issues.push({
      code: "LINKEDIN_MIXED_MEDIA",
      message: "LinkedIn no mezcla imágenes y video en una publicación",
    });
  }
  if (videos.length > 1) {
    issues.push({ code: "LINKEDIN_TOO_MANY_VIDEOS", message: "LinkedIn admite un solo video" });
  }
  if (images.length > LINKEDIN_LIMITS.images) {
    issues.push({
      code: "LINKEDIN_TOO_MANY_IMAGES",
      message: `LinkedIn admite hasta ${LINKEDIN_LIMITS.images} imágenes por publicación`,
    });
  }
  if (images.some((item) => !LINKEDIN_IMAGE_MIMES.has(item.mime))) {
    issues.push({
      code: "LINKEDIN_IMAGE_TYPE",
      message: "LinkedIn acepta imágenes JPG, PNG o GIF",
    });
  }
  if (
    images.some(
      (item) =>
        item.bytes > LINKEDIN_LIMITS.imageBytes ||
        (item.width ?? 0) * (item.height ?? 0) >= LINKEDIN_LIMITS.imagePixels,
    )
  ) {
    issues.push({
      code: "LINKEDIN_IMAGE_TOO_LARGE",
      message: "Una imagen es más grande de lo que acepta LinkedIn",
    });
  }
  for (const item of videos.slice(0, 1)) {
    if (item.mime !== "video/mp4") {
      issues.push({ code: "LINKEDIN_VIDEO_TYPE", message: "LinkedIn acepta video MP4" });
    }
    if (item.bytes < LINKEDIN_LIMITS.videoMinBytes || item.bytes > LINKEDIN_LIMITS.videoMaxBytes) {
      issues.push({
        code: "LINKEDIN_VIDEO_SIZE",
        message: "El video debe pesar entre 75 KB y 500 MB para LinkedIn",
      });
    }
    if (
      item.durationS !== null &&
      (item.durationS < LINKEDIN_LIMITS.videoMinS || item.durationS > LINKEDIN_LIMITS.videoMaxS)
    ) {
      issues.push({
        code: "LINKEDIN_VIDEO_DURATION",
        message: "El video debe durar entre 3 segundos y 30 minutos para LinkedIn",
      });
    }
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/** Los medios ya subidos en un intento anterior (`progress.linkedin.media`), por medio. */
const uploadedMediaSchema = z.object({
  media: z.array(
    z.object({
      mediaId: z.string(),
      urn: z.string().regex(/^urn:li:(image|video):[A-Za-z0-9_-]{1,100}$/),
    }),
  ),
});
const linkedinProgressSchema = z.looseObject({ linkedin: uploadedMediaSchema.optional() });
type UploadedMedia = z.infer<typeof uploadedMediaSchema>["media"];

/** Los URN ya subidos si calzan uno a uno, en orden, con los medios del input; si no, `null`. */
function reusableUploads(progress: unknown, input: PublishInput): UploadedMedia | null {
  const parsed = linkedinProgressSchema.safeParse(progress);
  const media = parsed.success ? parsed.data.linkedin?.media : undefined;
  if (media === undefined || media.length !== input.media.length) return null;
  return media.every((item, index) => item.mediaId === input.media[index]?.mediaId) ? media : null;
}

/**
 * Lee un medio por su URL firmada, entero o un tramo (`Range`), con tope de tiempo y comprobando el
 * largo. Ningún error lleva la URL: `LINKEDIN_MEDIA_UNAVAILABLE` (reintentable; no se publicó nada).
 */
export async function readMediaFromUrl(
  item: PublishMediaItem,
  range: MediaRange,
  { signal }: { signal?: AbortSignalLike | undefined } = {},
): Promise<Uint8Array> {
  if (signal?.aborted) throw LINKEDIN_ERRORS.aborted();
  const caller = new AbortController();
  const onAbort = () => caller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = AbortSignal.timeout(LINKEDIN_UPLOAD_TIMEOUT_MS);
  const expected = range === null ? null : range.last - range.first + 1;
  try {
    let response: Response;
    try {
      response = await fetch(item.url, {
        redirect: "error",
        ...(range === null ? {} : { headers: { Range: `bytes=${range.first}-${range.last}` } }),
        signal: AbortSignal.any([caller.signal, timeout]),
      });
    } catch {
      if (caller.signal.aborted) throw LINKEDIN_ERRORS.aborted();
      throw LINKEDIN_ERRORS.mediaUnavailable(item.mediaId, timeout.aborted ? "timeout" : "network");
    }
    const wholeFile = range !== null && range.first === 0 && expected === item.bytes;
    const statusOk =
      range === null ? response.ok : response.status === 206 || (wholeFile && response.ok);
    if (!statusOk) {
      throw LINKEDIN_ERRORS.mediaUnavailable(item.mediaId, `http_${response.status}`);
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      if (caller.signal.aborted) throw LINKEDIN_ERRORS.aborted();
      throw LINKEDIN_ERRORS.mediaUnavailable(item.mediaId, "network");
    }
    const sizeOk =
      expected === null
        ? bytes.byteLength > 0 && bytes.byteLength <= LINKEDIN_LIMITS.imageBytes
        : bytes.byteLength === expected;
    if (!sizeOk) throw LINKEDIN_ERRORS.mediaUnavailable(item.mediaId, "size");
    return bytes;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Espera `ms` o corta con la señal (`LINKEDIN_ABORTED`). */
function abortableSleep(ms: number, signal?: AbortSignalLike): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(LINKEDIN_ERRORS.aborted());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(LINKEDIN_ERRORS.aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** El contenido del post según los URN subidos: nada, un medio, o varias imágenes. */
function contentOf(input: PublishInput, uploaded: UploadedMedia): LinkedInPostContent {
  const [first] = uploaded;
  if (first === undefined) return { kind: "text" };
  if (input.media.some((item) => item.kind === "video") || uploaded.length === 1) {
    return { kind: "media", id: first.urn };
  }
  return { kind: "multiImage", ids: uploaded.map((item) => item.urn) };
}

/**
 * Publisher de LinkedIn, perfil personal, por la Posts API (spec F9 §4.4 a §4.6, D5; F9-T15;
 * `linkedin.md` §4):
 * 1. revisa el input (`validateLinkedInInput`) y arma el autor `urn:li:person:<id del miembro>`
 *    con la cuenta (si no tiene forma de id, `CREDENTIALS_INVALID`); el token sale siempre de
 *    `ctx.accessToken` (`platformContextOf`);
 * 2. si el progreso no tiene un envío anterior, sube los medios **antes** de "enviando": cada
 *    imagen con `initializeUpload` y un `PUT` de sus bytes; el video por partes de 4 MiB leídas de
 *    R2 con `Range`, `finalizeUpload` con los `ETag` y la espera hasta `AVAILABLE`. Guarda los URN
 *    en el progreso (`linkedin.media`): un reintento los reutiliza sin subir de nuevo;
 * 3. publica **una vez** con `sendOnce` (ADR-0029 punto 8): `POST /rest/posts` con el texto escapado
 *    (`escapeLinkedInText`, de core: los hashtags van como texto) y el contenido (`media` o
 *    `multiImage`). Los errores que prueban que no salió (`LINKEDIN_NOT_SENT_CODES`: 4xx, o no se
 *    llegó a conectar) quitan el "enviando"; cualquier otro (corte, 5xx, un 201 sin URN) es
 *    `OUTCOME_UNKNOWN`. Un medio rechazado borra los URN guardados (se suben de nuevo);
 * 4. devuelve el URN (`x-restli-id`, el `external_id`, el mismo formato que lee
 *    `parseLinkedInPostUrl`) y su enlace `https://www.linkedin.com/feed/update/<urn>/`.
 * Una cuenta en modo `manual` (por defecto, D5) nunca llega aquí: core deja el texto y los medios
 * listos sin llamar a la red (ADR-0029 punto 9).
 */
export function createLinkedInPublisher(options: LinkedInPublisherOptions = {}): DirectPublisher {
  let api = options.api;
  const readMedia = options.readMedia ?? readMediaFromUrl;
  const sleep = options.sleep ?? abortableSleep;
  const poll = options.videoPoll ?? LINKEDIN_VIDEO_POLL;

  const publisher: DirectPublisher = {
    platform: "linkedin",
    formats: ["post"],
    validate: validateLinkedInInput,
    async publish(input, ctx) {
      checkPublishInput(publisher, input);
      const { signal } = ctx;
      if (signal?.aborted) throw LINKEDIN_ERRORS.aborted();
      const memberId = linkedinMemberIdSchema.safeParse(ctx.account.externalAccountId);
      if (!memberId.success) throw LINKEDIN_ERRORS.credentialsInvalid();
      const author = linkedinPersonUrn(memberId.data);
      const commentary = escapeLinkedInText(input.caption);
      api ??= createLinkedInApi();
      const client = api;
      let token: string | null = null;
      const accessToken = async () => {
        token ??= await platformContextOf(ctx).accessToken(signal === undefined ? {} : { signal });
        return token;
      };

      let current: unknown = ctx.progress;
      let content: LinkedInPostContent = { kind: "text" };
      // Con un envío anterior (dudoso o ya hecho), `sendOnce` decide sin llamar: no se sube nada.
      const fresh = pendingSend(ctx.progress).kind === "none";
      try {
        // El token se pide **antes** de "enviando" (también en un post de solo texto): un fallo al
        // leer las credenciales no deja `outcome_unknown` sin haber enviado nada.
        if (fresh) await accessToken();
        if (fresh && input.media.length > 0) {
          let uploaded = reusableUploads(ctx.progress, input);
          if (uploaded === null) {
            uploaded = await uploadAll(client, await accessToken(), author, input, ctx);
            current = { linkedin: { media: uploaded } };
            await ctx.saveProgress(current);
          } else {
            options.onNote?.({
              publicationId: input.publicationId,
              kind: "media_reused",
              count: uploaded.length,
            });
          }
          const videoIndex = input.media.findIndex((item) => item.kind === "video");
          const videoUrn = uploaded[videoIndex]?.urn;
          const videoItem = input.media[videoIndex];
          if (videoUrn !== undefined && videoItem !== undefined) {
            await waitForVideo(client, await accessToken(), videoUrn, videoItem, input, ctx);
          }
          content = contentOf(input, uploaded);
        }
        const sent = await sendOnce(ctx, {
          progress: current,
          notSent: isLinkedInNotSent,
          send: async () => {
            const urn = await client.createPost(
              await accessToken(),
              { author, commentary, content },
              signal === undefined ? {} : { signal },
            );
            return { externalId: urn, externalUrl: linkedinPostUrl(urn) };
          },
        });
        return { ...sent, simulated: false };
      } catch (error) {
        // Un medio rechazado (o una subida vencida): el reintento los sube de nuevo.
        if (fresh && isAppError(error) && error.code === "LINKEDIN_MEDIA_REJECTED") {
          await ctx.saveProgress(null).catch(() => undefined);
        }
        throw error;
      }
    },
  };

  /** Sube los medios en orden y devuelve sus URN (nada se publica todavía). */
  async function uploadAll(
    client: LinkedInApi,
    token: string,
    author: string,
    input: PublishInput,
    ctx: PublishContext,
  ): Promise<UploadedMedia> {
    const call = ctx.signal === undefined ? {} : { signal: ctx.signal };
    const uploaded: UploadedMedia = [];
    for (const item of input.media) {
      if (item.kind === "video") {
        const init = await client.initializeVideoUpload(
          token,
          { owner: author, fileSizeBytes: item.bytes },
          call,
        );
        const etags: string[] = [];
        for (const part of init.parts) {
          const bytes = await readMedia(item, { first: part.firstByte, last: part.lastByte }, call);
          const etag = await client.uploadBytes(token, part.uploadUrl, bytes, call);
          if (etag === null || etag.trim() === "") {
            throw LINKEDIN_ERRORS.unexpectedResponse("uploadBytes", "etag");
          }
          etags.push(etag.trim());
        }
        await client.finalizeVideoUpload(
          token,
          { video: init.video, uploadToken: init.uploadToken, uploadedPartIds: etags },
          call,
        );
        uploaded.push({ mediaId: item.mediaId, urn: init.video });
      } else {
        // Primero los bytes: si R2 falla, no se gasta una llamada de LinkedIn.
        const bytes = await readMedia(item, null, call);
        const init = await client.initializeImageUpload(token, author, call);
        await client.uploadBytes(token, init.uploadUrl, bytes, call);
        uploaded.push({ mediaId: item.mediaId, urn: init.image });
      }
    }
    return uploaded;
  }

  /**
   * Espera a que el video quede `AVAILABLE` (`PROCESSING_FAILED`: `LINKEDIN_MEDIA_REJECTED`). Si
   * el token no puede leerlo (403, NO VERIFICADO con solo `w_member_social`) o se acaba la espera,
   * sigue: si LinkedIn aún no lo tiene listo, el post responde `MEDIA_ASSET_WAITING_UPLOAD`
   * (`LINKEDIN_MEDIA_NOT_READY`, reintentable) y el reintento reutiliza lo subido.
   */
  async function waitForVideo(
    client: LinkedInApi,
    token: string,
    urn: string,
    item: PublishMediaItem,
    input: PublishInput,
    ctx: PublishContext,
  ): Promise<void> {
    const call = ctx.signal === undefined ? {} : { signal: ctx.signal };
    for (let check = 1; check <= poll.attempts; check += 1) {
      let status: string;
      try {
        status = await client.getVideoStatus(token, urn, call);
      } catch (error) {
        if (isAppError(error) && error.code === "LINKEDIN_FORBIDDEN") {
          options.onNote?.({
            publicationId: input.publicationId,
            kind: "video_status_unreadable",
            mediaId: item.mediaId,
          });
          return;
        }
        throw error;
      }
      if (status === "AVAILABLE") return;
      if (status === "PROCESSING_FAILED") throw LINKEDIN_ERRORS.videoFailed(item.mediaId);
      if (check < poll.attempts) await sleep(poll.intervalMs, ctx.signal);
    }
    options.onNote?.({
      publicationId: input.publicationId,
      kind: "video_still_processing",
      mediaId: item.mediaId,
      checks: poll.attempts,
    });
  }

  return publisher;
}

/**
 * Borra un post publicado por la API (`DELETE /rest/posts/{urn}`, `linkedin.md` §4.5): idempotente.
 * Solo con un URN `share` o `ugcPost` (los que crea la API); uno `activity` (el del enlace que pega
 * el operador) no se sabe si sirve (S2): `LINKEDIN_DELETE_UNSUPPORTED`, y se borra a mano.
 * Retirar desde AgentSales todavía lo marca a mano (`retirePublication`); conectarlo aquí queda para
 * F9-T19 (spec F9, registro de cambios).
 */
export async function deleteLinkedInPost({
  api = createLinkedInApi(),
  accessToken,
  urn,
  signal,
}: {
  api?: LinkedInApi;
  accessToken: string;
  urn: string;
  signal?: AbortSignalLike;
}): Promise<void> {
  if (!/^urn:li:(share|ugcPost):\d{1,30}$/.test(urn)) {
    throw new AppError(
      "LINKEDIN_DELETE_UNSUPPORTED",
      "Esta publicación de LinkedIn se borra a mano: su enlace no trae el id que acepta la API",
    );
  }
  await api.deletePost(accessToken, urn, signal === undefined ? {} : { signal });
}
