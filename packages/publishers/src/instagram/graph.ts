import { type AbortSignalLike, type InstagramProfile, isAppError } from "@agentsales/core";
import { z } from "zod";
import {
  INSTAGRAM_GRAPH_ORIGIN,
  INSTAGRAM_GRAPH_VERSION,
  INSTAGRAM_REQUEST_TIMEOUT_MS,
} from "./constants.js";
import { graphErrorOf, INSTAGRAM_ERRORS, instagramError, retryAfterMinutesOf } from "./errors.js";

/** Opciones de cada llamada. */
export type CallOptions = { signal?: AbortSignalLike };

export type InstagramGraphOptions = {
  /** Por defecto `INSTAGRAM_GRAPH_VERSION`. */
  version?: string;
  /** Por defecto `https://graph.instagram.com`. */
  origin?: string;
  /** Tope de cada llamada; por defecto `INSTAGRAM_REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
};

/** Un contenedor por crear (nota §4.1 a §4.3). */
export type ContainerRequest =
  /** Imagen suelta (un carrusel de 1). */
  | { kind: "image"; imageUrl: string; caption: string }
  /** Un hijo de carrusel: sin caption. */
  | { kind: "carousel_item"; imageUrl: string }
  | { kind: "carousel"; children: readonly string[]; caption: string }
  | {
      kind: "reel";
      videoUrl: string;
      caption: string;
      thumbOffsetMs: number;
      shareToFeed: boolean;
    };

export const CONTAINER_STATUS_CODES = [
  "IN_PROGRESS",
  "FINISHED",
  "ERROR",
  "EXPIRED",
  "PUBLISHED",
] as const;
export type ContainerStatusCode = (typeof CONTAINER_STATUS_CODES)[number];

/**
 * Estado de un contenedor (nota §4.4); en `ERROR`, el subcódigo que trae `status`. Un estado que
 * Meta agregue y no conocemos llega como `UNKNOWN`: el publisher sigue sondeando (y, si no cambia,
 * termina en `IG_CONTAINER_TIMEOUT`) en vez de fallar sin reintento.
 */
export type ContainerStatus = {
  statusCode: ContainerStatusCode | "UNKNOWN";
  subcode: number | null;
};

/** Un medio publicado (nota §4.6). */
export type InstagramMedia = {
  id: string;
  permalink: string | null;
  timestamp: Date | null;
  caption: string | null;
  /** `IMAGE`, `VIDEO` o `CAROUSEL_ALBUM`. */
  mediaType: string | null;
  /** `FEED` o `REELS` (nota §4.6): distingue el carrusel del reel del mismo aviso. */
  productType: string | null;
};

/** Cupo de publicaciones de 24 h (nota §6); `quotaTotal` `null` si no vino. */
export type PublishingLimit = { quotaUsage: number; quotaTotal: number | null };

/**
 * Cliente de la Graph API con Instagram Login (spec F3 §4.5): host `graph.instagram.com`, versión
 * fija, token en la cabecera `Authorization: Bearer` (nunca en la URL) y respuestas validadas con
 * zod, con o sin la envoltura `data: [ ]`. Errores: los `IG_*` de `instagramError`, más
 * `IG_UNAVAILABLE` (red o tope de tiempo), `IG_ABORTED` (la señal) e `IG_UNEXPECTED_RESPONSE`.
 * Ningún error lleva el token, la URL ni el mensaje de Meta. No escribe logs.
 */
export interface InstagramGraph {
  me(accessToken: string, options?: CallOptions): Promise<InstagramProfile>;
  createContainer(
    accessToken: string,
    igUserId: string,
    request: ContainerRequest,
    options?: CallOptions,
  ): Promise<string>;
  containerStatus(
    accessToken: string,
    containerId: string,
    options?: CallOptions,
  ): Promise<ContainerStatus>;
  /**
   * `media_publish`: devuelve el id del medio publicado. Si la llamada no termina (`IG_UNAVAILABLE`
   * por red o tope de tiempo, `IG_ABORTED`, `IG_UNEXPECTED_RESPONSE`), el medio **pudo** publicarse:
   * el publisher no la repite a ciegas, sino que consulta el contenedor (spec F3 §4.4).
   */
  publishContainer(
    accessToken: string,
    igUserId: string,
    containerId: string,
    options?: CallOptions,
  ): Promise<string>;
  media(accessToken: string, mediaId: string, options?: CallOptions): Promise<InstagramMedia>;
  /** Los últimos medios de la cuenta, del más nuevo al más viejo. */
  recentMedia(
    accessToken: string,
    igUserId: string,
    options?: CallOptions & { limit?: number },
  ): Promise<InstagramMedia[]>;
  publishingLimit(
    accessToken: string,
    igUserId: string,
    options?: CallOptions,
  ): Promise<PublishingLimit>;
}

/**
 * Ids que Meta a veces manda como número. Uno mayor que 2^53 ya llegó corrupto de `JSON.parse`, y
 * zod lo rechaza (`IG_UNEXPECTED_RESPONSE`) en vez de guardar un id equivocado.
 */
const idSchema = z.union([z.string().min(1), z.number().int()]).transform(String);

const profileSchema = z.object({
  user_id: idSchema,
  username: z.string(),
  account_type: z.string(),
});
const idResponseSchema = z.object({ id: idSchema });
const statusSchema = z.object({
  status_code: z.string(),
  status: z.string().nullish(),
});
const isKnownStatus = (code: string): code is ContainerStatusCode =>
  (CONTAINER_STATUS_CODES as readonly string[]).includes(code);
const mediaSchema = z.object({
  id: idSchema,
  permalink: z.string().nullish(),
  timestamp: z.string().nullish(),
  caption: z.string().nullish(),
  media_type: z.string().nullish(),
  media_product_type: z.string().nullish(),
});
const limitSchema = z.object({
  quota_usage: z.number().int().nonnegative(),
  config: z.object({ quota_total: z.number().int().positive().nullish() }).nullish(),
});

const MEDIA_FIELDS = "id,permalink,timestamp,caption,media_type,media_product_type";

const toMedia = (raw: z.infer<typeof mediaSchema>): InstagramMedia => {
  const timestamp = raw.timestamp == null ? null : new Date(raw.timestamp);
  return {
    id: raw.id,
    permalink: raw.permalink ?? null,
    timestamp: timestamp === null || Number.isNaN(timestamp.getTime()) ? null : timestamp,
    caption: raw.caption ?? null,
    mediaType: raw.media_type ?? null,
    productType: raw.media_product_type ?? null,
  };
};

/** El subcódigo dentro del `status` de un contenedor en `ERROR` (por ejemplo `Error: 2207026`). */
export function subcodeOfStatus(status: string | null | undefined): number | null {
  const match = /\b(22\d{5})\b/.exec(status ?? "");
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** Campos del formulario de un contenedor (nota §4.1 a §4.3). */
function containerFields(request: ContainerRequest): Record<string, string> {
  switch (request.kind) {
    case "image":
      return { image_url: request.imageUrl, caption: request.caption };
    case "carousel_item":
      return { image_url: request.imageUrl, is_carousel_item: "true" };
    case "carousel":
      return {
        media_type: "CAROUSEL",
        children: request.children.join(","),
        caption: request.caption,
      };
    case "reel":
      return {
        media_type: "REELS",
        video_url: request.videoUrl,
        caption: request.caption,
        thumb_offset: String(request.thumbOffsetMs),
        share_to_feed: String(request.shareToFeed),
      };
  }
}

export function createInstagramGraph(options: InstagramGraphOptions = {}): InstagramGraph {
  const base = `${options.origin ?? INSTAGRAM_GRAPH_ORIGIN}/${options.version ?? INSTAGRAM_GRAPH_VERSION}`;
  const timeoutMs = options.timeoutMs ?? INSTAGRAM_REQUEST_TIMEOUT_MS;
  const url = (path: string, query: Record<string, string> = {}) => {
    const result = new URL(`${base}/${path}`);
    for (const [name, value] of Object.entries(query)) result.searchParams.set(name, value);
    return result;
  };
  const get = (call: string, accessToken: string, target: URL, callOptions: CallOptions = {}) =>
    instagramRequest(call, target, { method: "GET", accessToken }, { ...callOptions, timeoutMs });
  const post = (
    call: string,
    accessToken: string,
    target: URL,
    form: Record<string, string>,
    callOptions: CallOptions = {},
  ) =>
    instagramRequest(
      call,
      target,
      { method: "POST", accessToken, form },
      { ...callOptions, timeoutMs },
    );

  return {
    async me(accessToken, callOptions) {
      const body = await get(
        "me",
        accessToken,
        url("me", { fields: "user_id,username,account_type" }),
        callOptions,
      );
      const profile = parseSingle("me", profileSchema, body);
      return {
        userId: profile.user_id,
        username: profile.username,
        accountType: profile.account_type,
      };
    },
    async createContainer(accessToken, igUserId, request, callOptions) {
      const body = await post(
        "createContainer",
        accessToken,
        url(`${encodeURIComponent(igUserId)}/media`),
        containerFields(request),
        callOptions,
      );
      return parseSingle("createContainer", idResponseSchema, body).id;
    },
    async containerStatus(accessToken, containerId, callOptions) {
      const body = await get(
        "containerStatus",
        accessToken,
        url(encodeURIComponent(containerId), { fields: "status_code,status" }),
        callOptions,
      );
      const status = parseSingle("containerStatus", statusSchema, body);
      const statusCode = isKnownStatus(status.status_code) ? status.status_code : "UNKNOWN";
      return {
        statusCode,
        subcode: statusCode === "ERROR" ? subcodeOfStatus(status.status) : null,
      };
    },
    async publishContainer(accessToken, igUserId, containerId, callOptions) {
      const body = await post(
        "publishContainer",
        accessToken,
        url(`${encodeURIComponent(igUserId)}/media_publish`),
        { creation_id: containerId },
        callOptions,
      );
      return parseSingle("publishContainer", idResponseSchema, body).id;
    },
    async media(accessToken, mediaId, callOptions) {
      const body = await get(
        "media",
        accessToken,
        url(encodeURIComponent(mediaId), { fields: MEDIA_FIELDS }),
        callOptions,
      );
      return toMedia(parseSingle("media", mediaSchema, body));
    },
    async recentMedia(accessToken, igUserId, { limit = 10, ...callOptions } = {}) {
      const body = await get(
        "recentMedia",
        accessToken,
        url(`${encodeURIComponent(igUserId)}/media`, {
          fields: MEDIA_FIELDS,
          limit: String(limit),
        }),
        callOptions,
      );
      return parseList("recentMedia", mediaSchema, body).map(toMedia);
    },
    async publishingLimit(accessToken, igUserId, callOptions) {
      const body = await get(
        "publishingLimit",
        accessToken,
        url(`${encodeURIComponent(igUserId)}/content_publishing_limit`, {
          fields: "quota_usage,config",
        }),
        callOptions,
      );
      const limit = parseSingle("publishingLimit", limitSchema, body);
      return { quotaUsage: limit.quota_usage, quotaTotal: limit.config?.quota_total ?? null };
    },
  };
}

/** Una petición: el token va en la cabecera, o, si no hay, la URL ya trae lo que pide la doc. */
type RequestSpec = {
  method: "GET" | "POST";
  accessToken?: string;
  form?: Record<string, string>;
};

/** Un token válido: solo caracteres visibles de ASCII, sin espacios. */
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;

/**
 * Hace una llamada y devuelve el JSON, o lanza el `AppError` que corresponde. Ningún error lleva la
 * URL (el canje y el refresco llevan el secret y el token ahí, como pide la doc), la causa de
 * `fetch` ni el mensaje de Meta.
 */
export async function instagramRequest(
  call: string,
  target: URL,
  init: RequestSpec,
  { signal, timeoutMs }: CallOptions & { timeoutMs: number },
): Promise<unknown> {
  if (signal?.aborted) throw INSTAGRAM_ERRORS.aborted();
  // Un token con caracteres que no caben en una cabecera (por ejemplo, un salto de línea) haría
  // fallar a `fetch` como si fuera la red, y se reintentaría en vano.
  if (init.accessToken !== undefined && !TOKEN_PATTERN.test(init.accessToken)) {
    throw INSTAGRAM_ERRORS.malformedToken();
  }
  const caller = new AbortController();
  const onAbort = () => caller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = AbortSignal.timeout(timeoutMs);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.accessToken !== undefined) headers.Authorization = `Bearer ${init.accessToken}`;
  try {
    let response: Response;
    try {
      response = await fetch(target, {
        method: init.method,
        headers,
        body: init.form === undefined ? undefined : new URLSearchParams(init.form),
        signal: AbortSignal.any([caller.signal, timeout]),
      });
    } catch {
      if (caller.signal.aborted) throw INSTAGRAM_ERRORS.aborted();
      throw INSTAGRAM_ERRORS.unavailable(timeout.aborted ? "timeout" : "network");
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      if (caller.signal.aborted) throw INSTAGRAM_ERRORS.aborted();
      throw INSTAGRAM_ERRORS.unavailable(timeout.aborted ? "timeout" : "network");
    }
    let body: unknown = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      // Un cuerpo que no es JSON: lo decide el status.
    }
    const graphError = graphErrorOf(body);
    if (!response.ok || graphError !== null) {
      throw instagramError({
        httpStatus: response.status,
        code: graphError?.code ?? null,
        subcode: graphError?.subcode ?? null,
        retryAfterMinutes: retryAfterMinutesOf(response.headers.get("x-business-use-case-usage")),
      });
    }
    if (body === null) throw INSTAGRAM_ERRORS.unexpectedResponse(call);
    return body;
  } catch (error) {
    if (isAppError(error)) throw error;
    throw INSTAGRAM_ERRORS.unexpectedResponse(call);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Valida un objeto de la respuesta, tal cual o dentro de la envoltura `data: [ { … } ]` que muestra
 * la doc en el canje y en `/me` (nota §3.2 y §3.5).
 */
export function parseSingle<T>(call: string, schema: z.ZodType<T>, body: unknown): T {
  const direct = schema.safeParse(body);
  if (direct.success) return direct.data;
  const data = (body as { data?: unknown } | null)?.data;
  if (Array.isArray(data) && data.length === 1) {
    const wrapped = schema.safeParse(data[0]);
    if (wrapped.success) return wrapped.data;
  }
  throw INSTAGRAM_ERRORS.unexpectedResponse(call);
}

/** Valida una lista: dentro de `data: [ … ]` (lo normal en Graph) o como arreglo suelto. */
export function parseList<T>(call: string, schema: z.ZodType<T>, body: unknown): T[] {
  const items = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data;
  const parsed = z.array(schema).safeParse(items);
  if (!parsed.success) throw INSTAGRAM_ERRORS.unexpectedResponse(call);
  return parsed.data;
}
