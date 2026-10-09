import { type AbortSignalLike, type AppError, isAppError } from "@agentsales/core";
import { z } from "zod";
import {
  MERCADOLIBRE_ERRORS,
  type MercadoLibreErrorInfo,
  mercadoLibreError,
  mercadoLibreErrorOf,
} from "./errors.js";

/** Opciones de cada llamada (el nombre no choca con `CallOptions` de Instagram). */
export type MercadoLibreCallOptions = { signal?: AbortSignalLike };

export type MercadoLibreHttpOptions = {
  /** Por defecto `https://api.mercadolibre.com` (los tests usan el mismo, con msw). */
  origin?: string;
  /** Tope de cada llamada: 30 s en el worker (por defecto), 10 s en la API (spec F4 §4.3). */
  timeoutMs?: number;
};

/**
 * El cuerpo de una petición: un formulario (canje y refresco), JSON (ítems) o `multipart` (fotos,
 * nota §5). En `multipart` no se fija el `Content-Type`: `fetch` lo arma con su separador.
 */
export type RequestBody =
  | { form: Record<string, string> }
  | { json: unknown }
  | { multipart: FormData };

/**
 * Una petición: el token va en la cabecera `Authorization: Bearer`, nunca en la URL (nota §3.1);
 * el canje y el refresco van sin token y con los parámetros en un formulario. No hay `DELETE`: el
 * cliente nunca borra (spec F4 §3).
 */
export type RequestSpec = {
  method: "GET" | "POST" | "PUT";
  accessToken?: string;
  body?: RequestBody;
  /**
   * Clasifica un error antes de la tabla general (`mercadoLibreError`); `null` para seguir con
   * ella. Lo usa la subida de fotos: su límite por minuto responde 400 (nota §5).
   */
  classify?: (info: MercadoLibreErrorInfo) => AppError | null;
};

/** El cuerpo y su cabecera, listos para `fetch`. */
function encodeBody(body: RequestBody | undefined): {
  body?: URLSearchParams | string | FormData;
  contentType?: string;
} {
  if (body === undefined) return {};
  // `URLSearchParams` pone `application/x-www-form-urlencoded`, como pide el OAuth (nota §3.1).
  if ("form" in body) return { body: new URLSearchParams(body.form) };
  if ("json" in body) {
    return { body: JSON.stringify(body.json), contentType: "application/json" };
  }
  return { body: body.multipart };
}

/** Un token o un valor de formulario aceptable: solo caracteres visibles de ASCII, sin espacios. */
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;

/** ¿Puede ir en una cabecera o en un formulario sin cambiar ni romper la petición? */
export const isWellFormedToken = (token: string) => TOKEN_PATTERN.test(token);

/**
 * Hace una llamada y devuelve el JSON (`null` si vino vacío, como el `204` de `validate`), o lanza
 * el `AppError` que corresponde (`mercadoLibreError`, `ML_UNAVAILABLE` por red o tope, `ML_ABORTED`
 * por la señal, `ML_UNEXPECTED_RESPONSE` si un 2xx no es JSON o si responde con una redirección).
 * No sigue redirecciones: un 307 o 308 reenviaría el formulario (secret, código, refresh) a otra
 * dirección. Ningún error lleva la URL, el formulario, el token, la causa de `fetch` ni el mensaje
 * de Mercado Libre. No escribe logs.
 */
export async function mercadoLibreRequest(
  call: string,
  target: URL,
  init: RequestSpec,
  { signal, timeoutMs }: MercadoLibreCallOptions & { timeoutMs: number },
): Promise<unknown> {
  if (signal?.aborted) throw MERCADOLIBRE_ERRORS.aborted("before_send");
  // Un token con caracteres que no caben en una cabecera (por ejemplo, un salto de línea) haría
  // fallar a `fetch` como si fuera la red, y se reintentaría en vano.
  if (init.accessToken !== undefined && !isWellFormedToken(init.accessToken)) {
    throw MERCADOLIBRE_ERRORS.malformedToken();
  }
  // Antes de escuchar la señal: un cuerpo que no se puede armar no deja nada colgando.
  let encoded: ReturnType<typeof encodeBody>;
  try {
    encoded = encodeBody(init.body);
  } catch {
    throw MERCADOLIBRE_ERRORS.invalidBody(call);
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.accessToken !== undefined) headers.Authorization = `Bearer ${init.accessToken}`;
  if (encoded.contentType !== undefined) headers["Content-Type"] = encoded.contentType;
  const caller = new AbortController();
  const onAbort = () => caller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(target, {
        method: init.method,
        headers,
        body: encoded.body,
        redirect: "manual",
        signal: AbortSignal.any([caller.signal, timeout]),
      });
    } catch {
      if (caller.signal.aborted) throw MERCADOLIBRE_ERRORS.aborted();
      throw MERCADOLIBRE_ERRORS.unavailable(timeout.aborted ? "timeout" : "network");
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      if (caller.signal.aborted) throw MERCADOLIBRE_ERRORS.aborted();
      throw MERCADOLIBRE_ERRORS.unavailable(timeout.aborted ? "timeout" : "network");
    }
    let body: unknown = null;
    let parsed = true;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = false;
    }
    if (response.status >= 300 && response.status < 400) {
      throw MERCADOLIBRE_ERRORS.unexpectedResponse(call);
    }
    if (!response.ok) {
      // Un cuerpo que no es JSON (una página de un proxy): lo decide el status.
      const fields = mercadoLibreErrorOf(body);
      const info: MercadoLibreErrorInfo = {
        httpStatus: response.status,
        error: fields?.error ?? null,
        causes: fields?.causes ?? [],
      };
      throw init.classify?.(info) ?? mercadoLibreError(info);
    }
    if (!parsed) throw MERCADOLIBRE_ERRORS.unexpectedResponse(call);
    return body;
  } catch (error) {
    if (isAppError(error)) throw error;
    throw MERCADOLIBRE_ERRORS.unexpectedResponse(call);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Valida una respuesta con su esquema; si no calza, `ML_UNEXPECTED_RESPONSE` (sin el cuerpo). */
export function parseBody<T>(call: string, schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw MERCADOLIBRE_ERRORS.unexpectedResponse(call);
  return parsed.data;
}

/**
 * Ids que Mercado Libre manda como número (`user_id`, `id`). Uno mayor que 2^53 ya llegó corrupto
 * de `JSON.parse`, y se rechaza (`ML_UNEXPECTED_RESPONSE`) en vez de guardar un id equivocado.
 */
export const idSchema = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
  .transform(String);
