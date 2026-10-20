import type { AbortSignalLike } from "@agentsales/core";
import { z } from "zod";
import {
  LINKEDIN_API_ORIGIN,
  LINKEDIN_API_VERSION,
  LINKEDIN_REQUEST_TIMEOUT_MS,
  LINKEDIN_RESTLI_PROTOCOL_VERSION,
  LINKEDIN_UPLOAD_TIMEOUT_MS,
} from "./constants.js";
import { LINKEDIN_ERRORS } from "./errors.js";
import { linkedinFetch } from "./http.js";

/** Opciones de cada llamada. */
export type LinkedInCallOptions = { signal?: AbortSignalLike | undefined };

/** Una imagen inicializada: adónde subir sus bytes y su URN. */
export type LinkedInImageUpload = { image: string; uploadUrl: string };

/** Una parte de la subida de un video (`linkedin.md` §4.3): de qué byte a qué byte, y adónde. */
export type LinkedInUploadPart = { firstByte: number; lastByte: number; uploadUrl: string };

/** Un video inicializado: su URN, el token de la subida y sus partes, en orden. */
export type LinkedInVideoUpload = {
  video: string;
  uploadToken: string;
  parts: LinkedInUploadPart[];
};

/** El estado de un video en LinkedIn (`WAITING_UPLOAD`, `PROCESSING`, `AVAILABLE`, `PROCESSING_FAILED`). */
export type LinkedInVideoStatus = string;

/** El contenido de un post: nada (texto), un medio (imagen o video) o varias imágenes. */
export type LinkedInPostContent =
  | { kind: "text" }
  | { kind: "media"; id: string }
  | { kind: "multiImage"; ids: string[] };

/** Lo que se publica: el autor (`urn:li:person:…`), el texto ya escapado y el contenido. */
export type LinkedInPostRequest = {
  author: string;
  commentary: string;
  content: LinkedInPostContent;
};

/**
 * Cliente de la API REST de LinkedIn para publicar en el perfil personal (spec F9 §4.6, F9-T15;
 * `linkedin.md` §4): toda llamada lleva `Authorization: Bearer`, `Linkedin-Version` y
 * `X-Restli-Protocol-Version`. Las subidas de bytes van solo a URLs `https` de LinkedIn (las que
 * dio la inicialización): nunca se manda el token a otro host. Ningún error lleva el token, una URL
 * de subida ni el texto. Sin reintentos propios: los decide el publisher.
 */
export interface LinkedInApi {
  initializeImageUpload(
    accessToken: string,
    owner: string,
    options?: LinkedInCallOptions,
  ): Promise<LinkedInImageUpload>;
  initializeVideoUpload(
    accessToken: string,
    request: { owner: string; fileSizeBytes: number },
    options?: LinkedInCallOptions,
  ): Promise<LinkedInVideoUpload>;
  /** Sube bytes con `PUT` a una URL de subida; devuelve el `ETag` (las partes de video lo necesitan). */
  uploadBytes(
    accessToken: string,
    uploadUrl: string,
    bytes: Uint8Array,
    options?: LinkedInCallOptions,
  ): Promise<string | null>;
  finalizeVideoUpload(
    accessToken: string,
    request: { video: string; uploadToken: string; uploadedPartIds: string[] },
    options?: LinkedInCallOptions,
  ): Promise<void>;
  getVideoStatus(
    accessToken: string,
    video: string,
    options?: LinkedInCallOptions,
  ): Promise<LinkedInVideoStatus>;
  /** `POST /rest/posts`: **publica**. Devuelve el URN de `x-restli-id`. */
  createPost(
    accessToken: string,
    post: LinkedInPostRequest,
    options?: LinkedInCallOptions,
  ): Promise<string>;
  /** `DELETE /rest/posts/{urn}`: borra (idempotente: uno que ya no existe cuenta como borrado). */
  deletePost(accessToken: string, urn: string, options?: LinkedInCallOptions): Promise<void>;
}

export type LinkedInApiOptions = {
  /** Por defecto `https://api.linkedin.com`. */
  origin?: string;
  /** Tope de cada llamada; por defecto `LINKEDIN_REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Tope de cada subida de bytes; por defecto `LINKEDIN_UPLOAD_TIMEOUT_MS`. */
  uploadTimeoutMs?: number;
};

const urn = (type: string) => z.string().regex(new RegExp(`^urn:li:${type}:[A-Za-z0-9_-]{1,100}$`));

const imageInitSchema = z.object({
  value: z.looseObject({ uploadUrl: z.string().min(1), image: urn("image") }),
});

const videoInitSchema = z.object({
  value: z.looseObject({
    video: urn("video"),
    uploadToken: z.string().default(""),
    uploadInstructions: z
      .array(
        z.looseObject({
          firstByte: z.number().int().nonnegative(),
          lastByte: z.number().int().nonnegative(),
          uploadUrl: z.string().min(1),
        }),
      )
      .min(1),
  }),
});

const videoStatusSchema = z.looseObject({ status: z.string().min(1) });

/** El URN que devuelve `POST /rest/posts` en `x-restli-id` (`urn:li:share:…` o `urn:li:ugcPost:…`). */
const POST_URN = /^urn:li:(share|ugcPost):\d{1,30}$/;

/**
 * Si una URL de subida es de LinkedIn: `https`, sin usuario ni puerto, en `linkedin.com` o un
 * subdominio (`www.linkedin.com/dms-uploads/…`, `api.linkedin.com/mediaUpload/…`). Si LinkedIn
 * devolviera otra cosa, no se sube nada ahí (llevaría el token).
 */
export function isLinkedInUploadUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "" || url.port !== "") return false;
  return (
    url.protocol === "https:" &&
    (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com"))
  );
}

/** El cuerpo de `POST /rest/posts` (`linkedin.md` §4.2): público, en el feed, publicado. */
export function linkedinPostBody(post: LinkedInPostRequest): Record<string, unknown> {
  const content =
    post.content.kind === "media"
      ? { content: { media: { id: post.content.id } } }
      : post.content.kind === "multiImage"
        ? { content: { multiImage: { images: post.content.ids.map((id) => ({ id })) } } }
        : {};
  return {
    author: post.author,
    commentary: post.commentary,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
    ...content,
  };
}

export function createLinkedInApi(options: LinkedInApiOptions = {}): LinkedInApi {
  const origin = options.origin ?? LINKEDIN_API_ORIGIN;
  const timeoutMs = options.timeoutMs ?? LINKEDIN_REQUEST_TIMEOUT_MS;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? LINKEDIN_UPLOAD_TIMEOUT_MS;
  const headers = (accessToken: string, json = true): Record<string, string> => ({
    Authorization: `Bearer ${accessToken}`,
    "Linkedin-Version": LINKEDIN_API_VERSION,
    "X-Restli-Protocol-Version": LINKEDIN_RESTLI_PROTOCOL_VERSION,
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
  });
  const rest = (path: string, query: Record<string, string> = {}) => {
    const url = new URL(`${origin}/rest/${path}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  };
  const parse = <S extends z.ZodType>(call: string, schema: S, body: unknown): z.infer<S> => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw LINKEDIN_ERRORS.unexpectedResponse(call);
    return parsed.data;
  };

  return {
    async initializeImageUpload(accessToken, owner, { signal } = {}) {
      const call = "initializeImageUpload";
      const { body } = await linkedinFetch({
        call,
        url: rest("images", { action: "initializeUpload" }),
        method: "POST",
        headers: headers(accessToken),
        body: JSON.stringify({ initializeUploadRequest: { owner } }),
        timeoutMs,
        signal,
      });
      const { value } = parse(call, imageInitSchema, body);
      if (!isLinkedInUploadUrl(value.uploadUrl)) {
        throw LINKEDIN_ERRORS.unexpectedResponse(call, "upload_url");
      }
      return { image: value.image, uploadUrl: value.uploadUrl };
    },

    async initializeVideoUpload(accessToken, { owner, fileSizeBytes }, { signal } = {}) {
      const call = "initializeVideoUpload";
      const { body } = await linkedinFetch({
        call,
        url: rest("videos", { action: "initializeUpload" }),
        method: "POST",
        headers: headers(accessToken),
        body: JSON.stringify({
          initializeUploadRequest: {
            owner,
            fileSizeBytes,
            uploadCaptions: false,
            uploadThumbnail: false,
          },
        }),
        timeoutMs,
        signal,
      });
      const { value } = parse(call, videoInitSchema, body);
      const parts = value.uploadInstructions.map((part) => ({
        firstByte: part.firstByte,
        lastByte: part.lastByte,
        uploadUrl: part.uploadUrl,
      }));
      // Las partes cubren el archivo entero, en orden y sin huecos; y todas van a LinkedIn.
      let next = 0;
      for (const part of parts) {
        if (part.firstByte !== next || part.lastByte < part.firstByte) {
          throw LINKEDIN_ERRORS.unexpectedResponse(call, "upload_parts");
        }
        if (!isLinkedInUploadUrl(part.uploadUrl)) {
          throw LINKEDIN_ERRORS.unexpectedResponse(call, "upload_url");
        }
        next = part.lastByte + 1;
      }
      if (next !== fileSizeBytes) throw LINKEDIN_ERRORS.unexpectedResponse(call, "upload_parts");
      return { video: value.video, uploadToken: value.uploadToken, parts };
    },

    async uploadBytes(accessToken, uploadUrl, bytes, { signal } = {}) {
      const call = "uploadBytes";
      if (!isLinkedInUploadUrl(uploadUrl)) {
        throw LINKEDIN_ERRORS.unexpectedResponse(call, "upload_url");
      }
      // El verbo y las cabeceras de la subida de una imagen: NO VERIFICADO (`linkedin.md` §4.3, S2):
      // `PUT` con `Bearer`, como el ejemplo oficial de `curl --upload-file`.
      const response = await linkedinFetch({
        call,
        url: new URL(uploadUrl),
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/octet-stream",
        },
        body: bytes,
        timeoutMs: uploadTimeoutMs,
        signal,
      });
      return response.headers.get("etag");
    },

    async finalizeVideoUpload(accessToken, request, { signal } = {}) {
      await linkedinFetch({
        call: "finalizeVideoUpload",
        url: rest("videos", { action: "finalizeUpload" }),
        method: "POST",
        headers: headers(accessToken),
        body: JSON.stringify({ finalizeUploadRequest: request }),
        timeoutMs,
        signal,
      });
    },

    async getVideoStatus(accessToken, video, { signal } = {}) {
      const call = "getVideo";
      const { body } = await linkedinFetch({
        call,
        url: rest(`videos/${encodeURIComponent(video)}`),
        method: "GET",
        headers: headers(accessToken, false),
        timeoutMs,
        signal,
      });
      return parse(call, videoStatusSchema, body).status;
    },

    async createPost(accessToken, post, { signal } = {}) {
      const call = "createPost";
      const response = await linkedinFetch({
        call,
        url: rest("posts"),
        method: "POST",
        headers: headers(accessToken),
        body: JSON.stringify(linkedinPostBody(post)),
        timeoutMs,
        signal,
      });
      const id = response.headers.get("x-restli-id") ?? response.headers.get("x-linkedin-id");
      // Un 2xx sin el URN: LinkedIn lo aceptó y no se sabe cuál es (el publisher lo deja dudoso).
      if (id === null || !POST_URN.test(id.trim())) {
        throw LINKEDIN_ERRORS.unexpectedResponse(call, "post_urn");
      }
      return id.trim();
    },

    async deletePost(accessToken, postUrn, { signal } = {}) {
      try {
        await linkedinFetch({
          call: "deletePost",
          url: rest(`posts/${encodeURIComponent(postUrn)}`),
          method: "DELETE",
          headers: { ...headers(accessToken, false), "X-RestLi-Method": "DELETE" },
          timeoutMs,
          signal,
        });
      } catch (error) {
        // Borrar es idempotente (`linkedin.md` §4.5): uno que ya no existe ya está borrado.
        if ((error as { code?: unknown }).code === "LINKEDIN_NOT_FOUND") return;
        throw error;
      }
    },
  };
}
