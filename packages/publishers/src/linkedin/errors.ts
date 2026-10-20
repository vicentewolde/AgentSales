import { AppError, isAppError } from "@agentsales/core";
import { LINKEDIN_RATE_LIMIT_WAIT_MINUTES } from "./constants.js";

// Los errores de LinkedIn (spec F9 §4.6, F9-T15; `linkedin.md` §7). Ninguno lleva el token, el
// código del OAuth, el secret, la URL de subida, el texto publicado ni el mensaje de LinkedIn:
// solo el status, el código de LinkedIn (si es un identificador en mayúsculas) y la llamada.

/**
 * Los códigos que **prueban** que el post no se creó (el "no enviado" estricto de `sendOnce`,
 * ADR-0029 punto 8): LinkedIn rechazó la petición (4xx, incluidos el 409 "reintenta" y el 429) o no
 * se llegó a conectar. Un 5xx (también un token mal verificado, que LinkedIn informa como 500), un
 * corte, un tope de tiempo o un 201 sin el URN **no** están: el post pudo crearse y el intento
 * queda `outcome_unknown`.
 */
export const LINKEDIN_NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "LINKEDIN_AUTH_INVALID",
  "LINKEDIN_FORBIDDEN",
  "LINKEDIN_NOT_FOUND",
  "LINKEDIN_CONFLICT",
  "LINKEDIN_RATE_LIMITED",
  "LINKEDIN_REQUEST_REJECTED",
  "LINKEDIN_TEXT_TOO_LONG",
  "LINKEDIN_MEDIA_NOT_READY",
  "LINKEDIN_MEDIA_REJECTED",
  "LINKEDIN_VERSION_DEPRECATED",
  "LINKEDIN_UNREACHABLE",
  // Lo ve el publisher antes de llamar: no salió nada.
  "CREDENTIALS_INVALID",
]);

/** Si un error de LinkedIn prueba que el post no se creó. */
export const isLinkedInNotSent = (error: unknown): boolean =>
  isAppError(error) && LINKEDIN_NOT_SENT_CODES.has(error.code);

/** Los errores de red de Node **antes** de conectar: no salió ningún byte. */
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

/** Los errores sin respuesta de LinkedIn, o con una que no se puede usar. */
export const LINKEDIN_ERRORS = {
  /** No se llegó a conectar: no salió nada (reintentable, y "no enviado"). */
  unreachable: (call: string) =>
    error("LINKEDIN_UNREACHABLE", "No se pudo conectar con LinkedIn: reintenta más tarde", true, {
      call,
    }),
  /** Se cortó o venció el tope después de conectar, o un 5xx: lo pedido pudo hacerse. */
  unavailable: (call: string, reason: "network" | "timeout" | "server", httpStatus?: number) =>
    error("LINKEDIN_UNAVAILABLE", "LinkedIn no respondió: reintenta más tarde", true, {
      call,
      reason,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    }),
  aborted: () => error("LINKEDIN_ABORTED", "Se cortó la llamada a LinkedIn", true),
  unexpectedResponse: (call: string, reason?: string) =>
    error("LINKEDIN_UNEXPECTED_RESPONSE", "LinkedIn respondió algo inesperado", false, {
      call,
      ...(reason === undefined ? {} : { reason }),
    }),
  /** La cuenta guardada no sirve para publicar (sin token o sin el id del miembro): se reconecta. */
  credentialsInvalid: () =>
    new AppError(
      "CREDENTIALS_INVALID",
      "La cuenta de LinkedIn no tiene un acceso válido: vuelve a conectar con accounts connect linkedin",
    ),
  /** Un medio no se pudo leer de R2 antes de subirlo: no salió nada. */
  mediaUnavailable: (mediaId: string, reason: string) =>
    error(
      "LINKEDIN_MEDIA_UNAVAILABLE",
      "No se pudo leer un medio para subirlo a LinkedIn: reintenta más tarde",
      true,
      { mediaId, reason },
    ),
  /** El video no terminó de procesarse en LinkedIn (`PROCESSING_FAILED`): hay que rehacerlo. */
  videoFailed: (mediaId: string) =>
    error(
      "LINKEDIN_MEDIA_REJECTED",
      "LinkedIn no pudo procesar el video: revisa el archivo y vuelve a prepararlo",
      false,
      { mediaId, reason: "processing_failed" },
    ),
} as const;

/** El código de LinkedIn de un cuerpo de error (`code`, o uno conocido dentro de `message`). */
export function linkedinCodeOf(body: unknown): string | null {
  const record = body as { code?: unknown; message?: unknown } | null;
  if (typeof record?.code === "string" && /^[A-Z][A-Z0-9_]{1,60}$/.test(record.code)) {
    return record.code;
  }
  // A veces el código va dentro del mensaje (`linkedin.md` §7: la doc no fija dónde): se busca uno
  // de los conocidos, sin copiar el mensaje.
  if (typeof record?.message === "string") {
    for (const known of KNOWN_400_CODES) {
      if (record.message.includes(known)) return known;
    }
  }
  return null;
}

/** Los `400` de la Posts API que se distinguen (`linkedin.md` §7). */
const KNOWN_400_CODES = [
  "FIELD_LENGTH_TOO_LONG",
  "MEDIA_ASSET_WAITING_UPLOAD",
  "MEDIA_ASSET_PROCESSING_FAILED",
  "INVALID_IMAGE_ID",
  "INVALID_VIDEO_ID",
  "INVALID_DOCUMENT_ID",
  "EXPIRED_UPLOAD_URL",
  "INVALID_VALUE_BLANK_FIELD",
] as const;

const MEDIA_REJECTED_CODES: ReadonlySet<string> = new Set([
  "MEDIA_ASSET_PROCESSING_FAILED",
  "INVALID_IMAGE_ID",
  "INVALID_VIDEO_ID",
  "INVALID_DOCUMENT_ID",
  "EXPIRED_UPLOAD_URL",
]);

/**
 * El `AppError` de una respuesta de error de LinkedIn (`linkedin.md` §7):
 * - 401: `LINKEDIN_AUTH_INVALID` (token vencido, revocado o inválido; la cuenta queda vencida y se
 *   reconecta: el token de 60 días no se renueva solo);
 * - 403: `LINKEDIN_FORBIDDEN` (falta el permiso o el recurso es de otro);
 * - 404: `LINKEDIN_NOT_FOUND`; 409: `LINKEDIN_CONFLICT` (reintentable: "reintenta la petición");
 * - 426: `LINKEDIN_VERSION_DEPRECATED` (hay que subir `LINKEDIN_API_VERSION`);
 * - 429: `LINKEDIN_RATE_LIMITED`, reintentable, con `waitMinutes` (core reprograma, ADR-0018);
 * - 400 con `FIELD_LENGTH_TOO_LONG`: `LINKEDIN_TEXT_TOO_LONG`; con `MEDIA_ASSET_WAITING_UPLOAD`:
 *   `LINKEDIN_MEDIA_NOT_READY` (reintentable); con un medio inválido o una subida vencida:
 *   `LINKEDIN_MEDIA_REJECTED`; otro 4xx (también el 422): `LINKEDIN_REQUEST_REJECTED`;
 * - 5xx: `LINKEDIN_UNAVAILABLE`, reintentable pero **dudoso** al crear el post.
 */
export function linkedinHttpError({
  httpStatus,
  body,
  call,
  retryAfterHeader = null,
}: {
  httpStatus: number;
  body: unknown;
  call: string;
  retryAfterHeader?: string | null;
}): AppError {
  const code = linkedinCodeOf(body);
  const info = { call, httpStatus, ...(code === null ? {} : { linkedinCode: code }) };
  if (httpStatus === 401) {
    return error(
      "LINKEDIN_AUTH_INVALID",
      "LinkedIn rechazó el acceso de la cuenta (venció o se revocó): reconecta con accounts connect linkedin",
      false,
      info,
    );
  }
  if (httpStatus === 403) {
    return error(
      "LINKEDIN_FORBIDDEN",
      "LinkedIn no dejó hacer esto con esta cuenta (falta el permiso para publicar)",
      false,
      info,
    );
  }
  if (httpStatus === 404) {
    return error("LINKEDIN_NOT_FOUND", "LinkedIn no encontró lo pedido", false, info);
  }
  if (httpStatus === 409) {
    return error(
      "LINKEDIN_CONFLICT",
      "LinkedIn pidió reintentar: reintenta en un momento",
      true,
      info,
    );
  }
  if (httpStatus === 426) {
    return error(
      "LINKEDIN_VERSION_DEPRECATED",
      "LinkedIn cerró la versión de su API que usa AgentSales: hay que actualizarla",
      false,
      info,
    );
  }
  if (httpStatus === 429) {
    const seconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader.trim());
    const waitMinutes =
      Number.isFinite(seconds) && seconds >= 0
        ? Math.max(1, Math.ceil(seconds / 60))
        : LINKEDIN_RATE_LIMIT_WAIT_MINUTES;
    return error(
      "LINKEDIN_RATE_LIMITED",
      `LinkedIn limitó las llamadas de la cuenta: reintenta en ${waitMinutes} minuto${waitMinutes === 1 ? "" : "s"}`,
      true,
      { ...info, waitMinutes },
    );
  }
  if (httpStatus >= 400 && httpStatus < 500) {
    if (code === "FIELD_LENGTH_TOO_LONG") {
      return error(
        "LINKEDIN_TEXT_TOO_LONG",
        "El texto pasa del largo que acepta LinkedIn (3.000 caracteres)",
        false,
        info,
      );
    }
    if (code === "MEDIA_ASSET_WAITING_UPLOAD") {
      return error(
        "LINKEDIN_MEDIA_NOT_READY",
        "LinkedIn todavía procesa un medio: se reintenta en unos minutos",
        true,
        info,
      );
    }
    if (code !== null && MEDIA_REJECTED_CODES.has(code)) {
      return error("LINKEDIN_MEDIA_REJECTED", `LinkedIn rechazó un medio (${code})`, false, info);
    }
    return error(
      "LINKEDIN_REQUEST_REJECTED",
      `LinkedIn rechazó la petición (${code ?? `HTTP ${httpStatus}`})`,
      false,
      info,
    );
  }
  return LINKEDIN_ERRORS.unavailable(call, "server", httpStatus);
}
