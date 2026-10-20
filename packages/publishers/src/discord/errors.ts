import { AppError, isAppError } from "@agentsales/core";

// Los errores de Discord (spec F9 §4.6, F9-T14; `discord.md` §7.1). Ninguno lleva la URL del
// webhook (su token es el secreto), el mensaje de Discord ni el texto publicado: solo el status, el
// código JSON y, en un 429, la espera.

/**
 * Los códigos que **prueban** que el mensaje no se creó (el "no enviado" estricto de `sendOnce`,
 * ADR-0029 punto 8): Discord rechazó la petición (4xx, incluido el 429) o no se llegó a conectar.
 * Un 5xx, un corte, un tope de tiempo o una respuesta 2xx que no se lee **no** están: el mensaje
 * pudo crearse y el intento queda `outcome_unknown`.
 */
export const DISCORD_NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "DISCORD_RATE_LIMITED",
  "DISCORD_WEBHOOK_INVALID",
  "DISCORD_WEBHOOK_NOT_FOUND",
  "DISCORD_FORBIDDEN",
  "DISCORD_FILE_TOO_LARGE",
  "DISCORD_REQUEST_REJECTED",
  "DISCORD_UNREACHABLE",
]);

/** Si un error de Discord prueba que el mensaje no se creó. */
export const isDiscordNotSent = (error: unknown): boolean =>
  isAppError(error) && DISCORD_NOT_SENT_CODES.has(error.code);

/**
 * Los errores de red de Node que ocurren **antes** de conectar (el nombre no resuelve o el servidor
 * rechaza la conexión): no salió ningún byte, así que no hay mensaje.
 */
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

/** Los errores sin respuesta de Discord, o con una que no se puede leer. */
export const DISCORD_ERRORS = {
  /** No se llegó a conectar: no salió nada (reintentable, y "no enviado"). */
  unreachable: () =>
    error("DISCORD_UNREACHABLE", "No se pudo conectar con Discord: reintenta más tarde", true),
  /** Se cortó o venció el tope después de conectar: el mensaje pudo crearse. */
  unavailable: (reason: "network" | "timeout" | "server", httpStatus?: number) =>
    error("DISCORD_UNAVAILABLE", "Discord no respondió: reintenta más tarde", true, {
      reason,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    }),
  aborted: () => error("DISCORD_ABORTED", "Se cortó la llamada a Discord", true),
  unexpectedResponse: (call: string) =>
    error("DISCORD_UNEXPECTED_RESPONSE", "Discord respondió algo inesperado", false, { call }),
  /** La URL guardada no es la de un webhook: se reconecta (sin la URL en el error). */
  webhookMissing: () =>
    new AppError(
      "CREDENTIALS_INVALID",
      "La cuenta de Discord no tiene un webhook válido: vuelve a conectar con accounts connect discord",
    ),
  /** Un medio no se pudo bajar de R2 antes de enviar: no salió nada. */
  mediaUnavailable: (mediaId: string, reason: string) =>
    error(
      "DISCORD_MEDIA_UNAVAILABLE",
      "No se pudo leer un medio para adjuntarlo: reintenta más tarde",
      true,
      { mediaId, reason },
    ),
} as const;

/** Una espera de Discord en segundos (`retry_after` del cuerpo o `Retry-After`), o `null`. */
export function retryAfterSecondsOf(body: unknown, header: string | null): number | null {
  const fromBody = (body as { retry_after?: unknown } | null)?.retry_after;
  if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody >= 0) return fromBody;
  const fromHeader = header === null ? Number.NaN : Number(header.trim());
  return Number.isFinite(fromHeader) && fromHeader >= 0 ? fromHeader : null;
}

/** El código JSON de un error de Discord (`{ "code": 10015, … }`), o `null`. */
export function discordCodeOf(body: unknown): number | null {
  const code = (body as { code?: unknown } | null)?.code;
  return typeof code === "number" && Number.isInteger(code) ? code : null;
}

/** Sin `retry_after`, la espera que se supone ante un límite: 1 minuto. */
const DEFAULT_RETRY_AFTER_S = 60;

/**
 * El `AppError` de una respuesta de error de Discord, por el status y el código JSON (la doc no da
 * el status de cada código: se mira el código primero donde importa):
 * - 429 (y los códigos de límite `20028` y `40062`): `DISCORD_RATE_LIMITED`, reintentable, con
 *   `retryAfterS` y `waitMinutes` (la señal genérica de core para reprogramar, ADR-0018);
 * - 401 o `50027`: `DISCORD_WEBHOOK_INVALID` (el token del webhook no sirve);
 * - 404 (`10015` webhook o `10003` canal borrados): `DISCORD_WEBHOOK_NOT_FOUND`, con el consejo de
 *   volver a conectar; no reintentable (repetir un webhook 404 puede bloquear la IP);
 * - 403: `DISCORD_FORBIDDEN`, no reintentable (tampoco en bucle: muchos 401/403/429 bloquean la IP);
 * - 413, `40005` o `50045`: `DISCORD_FILE_TOO_LARGE`;
 * - otro 4xx: `DISCORD_REQUEST_REJECTED` (con un mensaje propio para `240000`, el filtro de enlaces,
 *   y `50006`, el mensaje vacío);
 * - 5xx: `DISCORD_UNAVAILABLE`, reintentable pero **dudoso** (no está en `DISCORD_NOT_SENT_CODES`).
 */
export function discordHttpError({
  httpStatus,
  body,
  retryAfterHeader,
}: {
  httpStatus: number;
  body: unknown;
  retryAfterHeader: string | null;
}): AppError {
  const code = discordCodeOf(body);
  const info = { httpStatus, ...(code === null ? {} : { discordCode: code }) };
  if (httpStatus === 429 || code === 20028 || code === 40062) {
    const retryAfterS = retryAfterSecondsOf(body, retryAfterHeader) ?? DEFAULT_RETRY_AFTER_S;
    const waitMinutes = Math.max(1, Math.ceil(retryAfterS / 60));
    return error(
      "DISCORD_RATE_LIMITED",
      `Discord limitó los envíos de este webhook: reintenta en ${waitMinutes} minuto${waitMinutes === 1 ? "" : "s"}`,
      true,
      { ...info, retryAfterS, waitMinutes },
    );
  }
  if (httpStatus === 401 || code === 50027) {
    return error(
      "DISCORD_WEBHOOK_INVALID",
      "Discord no acepta el webhook (su token ya no sirve): crea otro en el canal y vuelve a conectar",
      false,
      info,
    );
  }
  if (httpStatus === 404) {
    return error(
      "DISCORD_WEBHOOK_NOT_FOUND",
      "El webhook ya no existe: vuelve a conectar con un webhook nuevo del canal",
      false,
      info,
    );
  }
  if (httpStatus === 403) {
    return error(
      "DISCORD_FORBIDDEN",
      "Discord no dejó publicar con este webhook: revisa que el canal y el webhook sigan activos",
      false,
      info,
    );
  }
  if (httpStatus === 413 || code === 40005 || code === 50045) {
    return error(
      "DISCORD_FILE_TOO_LARGE",
      "Un archivo pesa más de lo que acepta Discord",
      false,
      info,
    );
  }
  if (httpStatus >= 400 && httpStatus < 500) {
    const message =
      code === 240000
        ? "Discord bloqueó el mensaje por un enlace (su filtro de enlaces dañinos): quítalo y reintenta"
        : code === 50006
          ? "Discord no acepta un mensaje vacío: falta el texto o un archivo"
          : `Discord rechazó el mensaje (código ${code ?? httpStatus})`;
    return error("DISCORD_REQUEST_REJECTED", message, false, info);
  }
  return DISCORD_ERRORS.unavailable("server", httpStatus);
}
