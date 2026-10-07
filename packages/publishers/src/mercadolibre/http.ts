import { type AbortSignalLike, isAppError } from "@agentsales/core";
import { z } from "zod";
import { MERCADOLIBRE_ERRORS, mercadoLibreError, mercadoLibreErrorOf } from "./errors.js";

/** Opciones de cada llamada (el nombre no choca con `CallOptions` de Instagram). */
export type MercadoLibreCallOptions = { signal?: AbortSignalLike };

export type MercadoLibreHttpOptions = {
  /** Por defecto `https://api.mercadolibre.com` (los tests usan el mismo, con msw). */
  origin?: string;
  /** Tope de cada llamada: 30 s en el worker (por defecto), 10 s en la API (spec F4 §4.3). */
  timeoutMs?: number;
};

/**
 * Una petición: el token va en la cabecera `Authorization: Bearer`, nunca en la URL (nota §3.1);
 * el canje y el refresco van sin token y con los parámetros en un formulario.
 */
export type RequestSpec = {
  method: "GET" | "POST" | "PUT";
  accessToken?: string;
  form?: Record<string, string>;
};

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
  if (signal?.aborted) throw MERCADOLIBRE_ERRORS.aborted();
  // Un token con caracteres que no caben en una cabecera (por ejemplo, un salto de línea) haría
  // fallar a `fetch` como si fuera la red, y se reintentaría en vano.
  if (init.accessToken !== undefined && !isWellFormedToken(init.accessToken)) {
    throw MERCADOLIBRE_ERRORS.malformedToken();
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
        // `URLSearchParams` pone `application/x-www-form-urlencoded`, como pide el OAuth (nota §3.1).
        body: init.form === undefined ? undefined : new URLSearchParams(init.form),
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
      throw mercadoLibreError({
        httpStatus: response.status,
        error: fields?.error ?? null,
        causes: fields?.causes ?? [],
      });
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
