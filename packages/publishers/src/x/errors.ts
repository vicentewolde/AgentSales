import { AppError, isAppError } from "@agentsales/core";
import { X_DEFAULT_RATE_LIMIT_WAIT_S } from "./constants.js";

// Los errores de X (spec F9 §4.6, F9-T16; `x.md` §7). Ninguno lleva un token, el secret, el código,
// el verificador, el texto publicado ni el mensaje de X: solo el status, el tipo del problema
// (`type` de `application/problem+json`) y, en un 429, la espera.

/**
 * Los códigos que **prueban** que el post no se creó (el "no enviado" estricto de `sendOnce`,
 * ADR-0029 punto 8): X rechazó la petición antes de crear nada (un 4xx que no es el de texto
 * repetido, incluidos el 402 por saldo y el 429) o no se llegó a conectar. **No** están: el 403
 * por texto repetido (`X_DUPLICATE_CONTENT`: el post pudo haber salido en un intento que se cortó,
 * spec F9 §4.6), un 5xx, un corte, un tope de tiempo o una respuesta 2xx que no se lee: el intento
 * queda `outcome_unknown`.
 */
export const X_NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "X_RATE_LIMITED",
  "X_PAYMENT_REQUIRED",
  "X_AUTH_INVALID",
  "X_FORBIDDEN",
  "X_REQUEST_REJECTED",
  "X_UNREACHABLE",
]);

/** Si un error de X prueba que el post no se creó. */
export const isXNotSent = (error: unknown): boolean =>
  isAppError(error) && X_NOT_SENT_CODES.has(error.code);

/** Los errores de red de Node que ocurren **antes** de conectar: no salió ningún byte. */
export const PRE_CONNECT_ERROR_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
]);

/** El código de red de la causa de un `fetch` fallido (`TypeError` con `cause.code`), si lo hay. */
export function networkCodeOf(error: unknown): string | null {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

const error = (
  code: string,
  message: string,
  retriable: boolean,
  details: Record<string, unknown> = {},
) => new AppError(code, message, { retriable, details });

/** Los errores sin respuesta de X, o con una que no se puede leer. */
export const X_ERRORS = {
  /** No se llegó a conectar: no salió nada (reintentable, y "no enviado"). */
  unreachable: (call: string) =>
    error("X_UNREACHABLE", "No se pudo conectar con X: reintenta más tarde", true, { call }),
  /** Se cortó o venció el tope después de conectar: el post pudo crearse. */
  unavailable: (call: string, reason: "network" | "timeout" | "server", httpStatus?: number) =>
    error("X_UNAVAILABLE", "X no respondió: reintenta más tarde", true, {
      call,
      reason,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    }),
  aborted: () => error("X_ABORTED", "Se cortó la llamada a X", true),
  unexpectedResponse: (call: string) =>
    error("X_UNEXPECTED_RESPONSE", "X respondió algo inesperado", false, { call }),
  /** Un medio no se pudo bajar de R2 antes de subirlo: no salió nada. */
  mediaUnavailable: (mediaId: string, reason: string) =>
    error(
      "X_MEDIA_UNAVAILABLE",
      "No se pudo leer un medio para subirlo a X: reintenta más tarde",
      true,
      { mediaId, reason },
    ),
  /** X no terminó de procesar el video a tiempo: se reintenta (reutiliza el medio si sigue vigente). */
  mediaProcessingTimeout: (mediaId: string) =>
    error(
      "X_MEDIA_PROCESSING_TIMEOUT",
      "X todavía está procesando el video: reintenta en unos minutos",
      true,
      { mediaId },
    ),
  /** X procesó el video y lo rechazó (`processing_info.state = failed`). */
  mediaRejected: (mediaId: string, reason: string | null) =>
    error("X_MEDIA_REJECTED", "X no aceptó el video del post", false, {
      mediaId,
      ...(reason === null ? {} : { reason }),
    }),
  /** El token de la cuenta no se pudo renovar después de un 401: no salió nada. */
  authInvalidAfterRefresh: () =>
    error(
      "X_AUTH_INVALID",
      "X no acepta el acceso de la cuenta y no se pudo renovar: reconéctala con accounts connect x",
      false,
      { reason: "rejected_after_refresh" },
    ),
} as const;

/** El `type` de un problema de X (`https://api.x.com/2/problems/<tipo>`), sin el prefijo, o `null`. */
export function xProblemTypeOf(body: unknown): string | null {
  const type = (body as { type?: unknown } | null)?.type;
  if (typeof type !== "string") return null;
  const short = type.replace(/^https:\/\/api\.(?:x|twitter)\.com\/2\/problems\//, "");
  return /^[a-z0-9-]{1,60}$/i.test(short) ? short : null;
}

/** El `error` de una respuesta de OAuth (`invalid_grant`, `invalid_client`…), o `null`. */
export function oauthErrorOf(body: unknown): string | null {
  const value = (body as { error?: unknown } | null)?.error;
  return typeof value === "string" && /^[a-z_]{1,40}$/.test(value) ? value : null;
}

/** Todo el texto de un error de X que sirve para reconocer el texto repetido. */
function problemText(body: unknown): string {
  if (body === null || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  const parts = [record.title, record.detail, record.message];
  const errors = record.errors;
  if (Array.isArray(errors)) {
    for (const item of errors) {
      const entry = item as Record<string, unknown> | null;
      parts.push(entry?.message, entry?.detail, entry?.title);
    }
  }
  return parts.filter((part): part is string => typeof part === "string").join(" ");
}

/**
 * Si un 403 es el rechazo por texto repetido (`x.md` §7.3: PISTAS de terceros, "You are not allowed
 * to create a Tweet with duplicate content"; el texto exacto es NO VERIFICADO hasta S4). Se
 * reconoce por "duplicate" en el título, el detalle o los errores.
 */
export const isDuplicateContent = (body: unknown): boolean => /duplicate/i.test(problemText(body));

/**
 * La espera de un 429 en segundos: hasta `x-rate-limit-reset` (marca Unix de cuándo se libera la
 * ventana, `x.md` §6.1), o `Retry-After`, o 15 min.
 */
export function rateLimitWaitSeconds(headers: Headers, now: Date): number {
  const reset = Number(headers.get("x-rate-limit-reset") ?? Number.NaN);
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(1, Math.ceil(reset - now.getTime() / 1000));
  }
  const retryAfter = Number(headers.get("retry-after") ?? Number.NaN);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.max(1, Math.ceil(retryAfter));
  return X_DEFAULT_RATE_LIMIT_WAIT_S;
}

/**
 * El `AppError` de una respuesta de error de X (`x.md` §7.1), por el status:
 * - 429: `X_RATE_LIMITED`, reintentable, con `retryAfterS` y `waitMinutes` (la señal genérica de
 *   core para reprogramar, ADR-0018);
 * - 402: `X_PAYMENT_REQUIRED` (créditos agotados o el tope de la consola), no reintentable, con el
 *   consejo de recargar;
 * - 401 (y un `invalid_grant` del OAuth): `X_AUTH_INVALID`, con `oauthError` si lo hay;
 *   `invalid_client` es `X_APP_CREDENTIALS_INVALID` (el par de la app);
 * - 403 por texto repetido: `X_DUPLICATE_CONTENT` (no reintentable y **dudoso**: no está en
 *   `X_NOT_SENT_CODES`); otro 403: `X_FORBIDDEN`;
 * - otro 4xx: `X_REQUEST_REJECTED` (`X_MEDIA_REJECTED` en una subida);
 * - 5xx: `X_UNAVAILABLE`, reintentable pero dudoso.
 */
export function xHttpError({
  call,
  httpStatus,
  body,
  headers,
  now = new Date(),
}: {
  call: string;
  httpStatus: number;
  body: unknown;
  headers: Headers;
  now?: Date;
}): AppError {
  const problemType = xProblemTypeOf(body);
  const oauthError = oauthErrorOf(body);
  const info = {
    call,
    httpStatus,
    ...(problemType === null ? {} : { problemType }),
    ...(oauthError === null ? {} : { oauthError }),
  };
  if (httpStatus === 429) {
    const retryAfterS = rateLimitWaitSeconds(headers, now);
    const waitMinutes = Math.max(1, Math.ceil(retryAfterS / 60));
    return error(
      "X_RATE_LIMITED",
      `X limitó los envíos de esta cuenta: reintenta en ${waitMinutes} minuto${waitMinutes === 1 ? "" : "s"}`,
      true,
      { ...info, retryAfterS, waitMinutes },
    );
  }
  if (httpStatus === 402) {
    return error(
      "X_PAYMENT_REQUIRED",
      "X no publicó: la cuenta de desarrollador no tiene créditos o llegó a su tope de gasto (402). Recarga créditos en la consola de X y reintenta",
      false,
      info,
    );
  }
  if (oauthError === "invalid_client") {
    return error(
      "X_APP_CREDENTIALS_INVALID",
      "X no reconoce el par de la app: revisa X_CLIENT_ID y X_CLIENT_SECRET en .env",
      false,
      info,
    );
  }
  if (httpStatus === 401 || oauthError === "invalid_grant") {
    return error(
      "X_AUTH_INVALID",
      "X no acepta el acceso de la cuenta (venció o se revocó): reconéctala con accounts connect x",
      false,
      info,
    );
  }
  if (httpStatus === 403 && isDuplicateContent(body)) {
    return error(
      "X_DUPLICATE_CONTENT",
      "X rechazó el post por texto repetido: puede que ya haya salido en un intento anterior. Revisa la cuenta en X y di si salió (con el enlace) o si no salió",
      false,
      info,
    );
  }
  if (httpStatus === 403) {
    return error(
      "X_FORBIDDEN",
      "X no dejó publicar (403): revisa los permisos de la app (lectura y escritura), el video o la cuenta",
      false,
      info,
    );
  }
  if (httpStatus >= 400 && httpStatus < 500) {
    return call.startsWith("media")
      ? error("X_MEDIA_REJECTED", `X no aceptó un medio (código ${httpStatus})`, false, info)
      : error("X_REQUEST_REJECTED", `X rechazó la petición (código ${httpStatus})`, false, info);
  }
  return X_ERRORS.unavailable(call, "server", httpStatus);
}
