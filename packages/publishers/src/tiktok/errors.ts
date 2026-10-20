import { AppError, isAppError } from "@agentsales/core";
import { TIKTOK_PENDING_LIMIT_WAIT_MINUTES } from "./constants.js";

// Los errores de TikTok (spec F9 §4.6, F9-T26; `tiktok.md` §6). Ninguno lleva un token, el secret
// de la app, el código de autorización, la URL de subida ni el mensaje de TikTok: solo el status,
// el código de TikTok (`error.code` o el `error` del OAuth) y su `log_id` (para pedir ayuda).

const error = (
  code: string,
  message: string,
  retriable: boolean,
  details: Record<string, unknown> = {},
) => new AppError(code, message, { retriable, details });

/**
 * Los errores de red de Node que ocurren **antes** de conectar (el nombre no resuelve o el servidor
 * rechaza la conexión): no salió ningún byte.
 */
const PRE_CONNECT_ERROR_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
]);

/** El código de red de la causa de un `fetch` fallido (`TypeError` con `cause.code`), si lo hay. */
function networkCodeOf(caught: unknown): string | null {
  const cause = (caught as { cause?: unknown } | null)?.cause;
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** Los errores sin respuesta de TikTok, o con una que no se lee. */
export const TIKTOK_ERRORS = {
  /** No se llegó a conectar: no salió nada. */
  unreachable: (call: string) =>
    error("TIKTOK_UNREACHABLE", "No se pudo conectar con TikTok: reintenta más tarde", true, {
      call,
    }),
  /** Se cortó, venció el tope o respondió un 5xx después de conectar. */
  unavailable: (call: string, reason: "network" | "timeout" | "server", httpStatus?: number) =>
    error("TIKTOK_UNAVAILABLE", "TikTok no respondió: reintenta más tarde", true, {
      call,
      reason,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    }),
  aborted: () => error("TIKTOK_ABORTED", "Se cortó la llamada a TikTok", true),
  unexpectedResponse: (call: string) =>
    error("TIKTOK_UNEXPECTED_RESPONSE", "TikTok respondió algo inesperado", false, { call }),
  /** Las credenciales guardadas no tienen token: se reconecta. */
  credentialsMissing: () =>
    new AppError(
      "CREDENTIALS_INVALID",
      "La cuenta de TikTok no tiene un acceso válido: vuelve a conectar con accounts connect tiktok",
    ),
  /** Un trozo del video no se pudo leer de R2 antes de subirlo. */
  mediaUnavailable: (mediaId: string, reason: string) =>
    error(
      "TIKTOK_MEDIA_UNAVAILABLE",
      "No se pudo leer el video para subirlo a TikTok: reintenta más tarde",
      true,
      { mediaId, reason },
    ),
  /** TikTok rechazó un trozo (4xx en la URL de subida): el video no quedó completo. */
  uploadRejected: (httpStatus: number, chunk: number) =>
    error(
      "TIKTOK_UPLOAD_REJECTED",
      "TikTok rechazó una parte del video: se reintenta desde el principio",
      true,
      { httpStatus, chunk },
    ),
} as const;

/**
 * Lo que pasó con un `fetch` que no trajo respuesta: la señal (`TIKTOK_ABORTED`), un error antes de
 * conectar (`TIKTOK_UNREACHABLE`) o un corte o tope después (`TIKTOK_UNAVAILABLE`).
 */
export function tiktokFetchFailure(
  call: string,
  caught: unknown,
  { aborted, timedOut }: { aborted: boolean; timedOut: boolean },
): AppError {
  if (aborted) return TIKTOK_ERRORS.aborted();
  if (timedOut) return TIKTOK_ERRORS.unavailable(call, "timeout");
  const network = networkCodeOf(caught);
  if (network !== null && PRE_CONNECT_ERROR_CODES.has(network)) {
    return TIKTOK_ERRORS.unreachable(call);
  }
  return TIKTOK_ERRORS.unavailable(call, "network");
}

/** El `log_id` de una respuesta de TikTok, si viene (no es secreto: sirve para pedir ayuda). */
function logIdOf(body: unknown): string | null {
  const nested = (body as { error?: { log_id?: unknown } } | null)?.error;
  const value =
    typeof nested === "object" && nested !== null
      ? nested.log_id
      : (body as { log_id?: unknown } | null)?.log_id;
  return typeof value === "string" && /^[\w-]{1,100}$/.test(value) ? value : null;
}

/** Un código de TikTok tal como se guarda: letras, dígitos y `_` (nunca un texto libre). */
const codeSchema = /^[a-z0-9_.]{1,80}$/i;

/** El `error` del OAuth (`{ "error": "invalid_grant", … }`), o `null`. */
export function oauthErrorOf(body: unknown): string | null {
  const value = (body as { error?: unknown } | null)?.error;
  return typeof value === "string" && codeSchema.test(value) ? value : null;
}

/** El `error.code` de la API (`{ "error": { "code": "ok", … } }`), o `null`. */
export function apiErrorCodeOf(body: unknown): string | null {
  const nested = (body as { error?: unknown } | null)?.error;
  const value = (nested as { code?: unknown } | null)?.code;
  return typeof value === "string" && codeSchema.test(value) ? value : null;
}

/**
 * El `AppError` de un error del OAuth (canje o renovación, `tiktok.md` §4):
 * - `invalid_grant`: `TIKTOK_AUTH_INVALID` con `oauthError` (el código venció o se usó; al renovar,
 *   el refresh token ya no sirve: el **único** rechazo que deja la cuenta vencida, ADR-0029 punto 11);
 * - `invalid_client` y `unauthorized_client`: `TIKTOK_APP_CREDENTIALS_INVALID` (el par de la app);
 * - `access_denied`: `TIKTOK_PERMISSION_DENIED`;
 * - 429 o `rate_limit_exceeded`: `TIKTOK_RATE_LIMITED` (reintentable);
 * - 5xx o `server_error`/`temporarily_unavailable`: `TIKTOK_UNAVAILABLE` (reintentable);
 * - otro: `TIKTOK_REQUEST_REJECTED`.
 */
export function tiktokOAuthError(call: string, httpStatus: number, body: unknown): AppError {
  const oauthError = oauthErrorOf(body);
  const info = {
    call,
    httpStatus,
    ...(oauthError === null ? {} : { oauthError }),
    ...(logIdOf(body) === null ? {} : { logId: logIdOf(body) }),
  };
  if (oauthError === "invalid_grant") {
    return error(
      "TIKTOK_AUTH_INVALID",
      call === "refresh"
        ? "TikTok ya no acepta el acceso de la cuenta (venció o se revocó): reconéctala"
        : "TikTok no aceptó el código de conexión (venció, ya se usó o la dirección de retorno no coincide): conecta de nuevo",
      false,
      info,
    );
  }
  if (oauthError === "invalid_client" || oauthError === "unauthorized_client") {
    return error(
      "TIKTOK_APP_CREDENTIALS_INVALID",
      "TikTok no reconoce la app: revisa TIKTOK_CLIENT_KEY y TIKTOK_CLIENT_SECRET",
      false,
      info,
    );
  }
  if (oauthError === "access_denied") {
    return error("TIKTOK_PERMISSION_DENIED", "TikTok no dio el permiso pedido", false, info);
  }
  if (httpStatus === 429 || oauthError === "rate_limit_exceeded") {
    return error(
      "TIKTOK_RATE_LIMITED",
      "TikTok limitó las llamadas: reintenta en un minuto",
      true,
      {
        ...info,
        waitMinutes: 1,
      },
    );
  }
  if (
    httpStatus >= 500 ||
    oauthError === "server_error" ||
    oauthError === "temporarily_unavailable"
  ) {
    return TIKTOK_ERRORS.unavailable(call, "server", httpStatus);
  }
  return error(
    "TIKTOK_REQUEST_REJECTED",
    `TikTok rechazó el pedido (${oauthError ?? httpStatus})`,
    false,
    info,
  );
}

/**
 * El `AppError` de un error de la API de publicación o de usuario (`tiktok.md` §6), por el código
 * de TikTok primero y el status después:
 * - `access_token_invalid`: `TIKTOK_AUTH_INVALID` con `reason` (el publisher pide otro token una
 *   vez; si se repite, la cuenta queda vencida);
 * - `scope_not_authorized` (y `scope_permission_missed`): `TIKTOK_PERMISSION_DENIED`;
 * - `spam_risk_too_many_pending_share`: `TIKTOK_PENDING_LIMIT` (5 pendientes en la bandeja por
 *   24 h), con `waitMinutes`: core reprograma (ADR-0018) hasta 3 veces;
 * - `spam_risk_too_many_posts`: `TIKTOK_POST_LIMIT`, con `waitMinutes`;
 * - otro `spam_risk*`: `TIKTOK_ACCOUNT_RESTRICTED`;
 * - `reached_active_user_cap`, `unaudited_client_can_only_post_to_private_accounts` y
 *   `privacy_level_option_mismatch`: `TIKTOK_APP_RESTRICTED` (la auditoría, prueba S6);
 * - 429 o `rate_limit_exceeded`: `TIKTOK_RATE_LIMITED` (reintentable, `waitMinutes: 1`);
 * - 5xx o `internal_error`: `TIKTOK_UNAVAILABLE` (reintentable);
 * - otro 4xx: `TIKTOK_REQUEST_REJECTED`.
 */
export function tiktokApiError(call: string, httpStatus: number, body: unknown): AppError {
  const tiktokCode = apiErrorCodeOf(body);
  const logId = logIdOf(body);
  const info = {
    call,
    httpStatus,
    ...(tiktokCode === null ? {} : { tiktokCode }),
    ...(logId === null ? {} : { logId }),
  };
  switch (tiktokCode) {
    case "access_token_invalid":
      return error(
        "TIKTOK_AUTH_INVALID",
        "TikTok no aceptó el acceso de la cuenta: reconéctala",
        false,
        { ...info, reason: "access_token_invalid" },
      );
    case "scope_not_authorized":
    case "scope_permission_missed":
      return error(
        "TIKTOK_PERMISSION_DENIED",
        "La cuenta no dio el permiso de subir videos: reconéctala aceptándolo",
        false,
        info,
      );
    case "spam_risk_too_many_pending_share":
      return error(
        "TIKTOK_PENDING_LIMIT",
        "Ya hay 5 videos esperando en la bandeja de TikTok (el máximo en 24 horas): publícalos o descártalos en la app",
        false,
        { ...info, waitMinutes: TIKTOK_PENDING_LIMIT_WAIT_MINUTES },
      );
    case "spam_risk_too_many_posts":
      return error(
        "TIKTOK_POST_LIMIT",
        "La cuenta llegó a su máximo de publicaciones del día en TikTok",
        false,
        { ...info, waitMinutes: 3 * 60 },
      );
    case "reached_active_user_cap":
    case "unaudited_client_can_only_post_to_private_accounts":
    case "privacy_level_option_mismatch":
      return error(
        "TIKTOK_APP_RESTRICTED",
        "La app de TikTok no tiene la auditoría que esto necesita",
        false,
        info,
      );
    case "rate_limit_exceeded":
      return error(
        "TIKTOK_RATE_LIMITED",
        "TikTok limitó las llamadas: reintenta en un minuto",
        true,
        { ...info, waitMinutes: 1 },
      );
    case "internal_error":
      return TIKTOK_ERRORS.unavailable(call, "server", httpStatus);
  }
  if (tiktokCode?.startsWith("spam_risk") === true) {
    return error(
      "TIKTOK_ACCOUNT_RESTRICTED",
      "TikTok no deja publicar a esta cuenta por ahora",
      false,
      info,
    );
  }
  if (httpStatus === 429) {
    return error(
      "TIKTOK_RATE_LIMITED",
      "TikTok limitó las llamadas: reintenta en un minuto",
      true,
      {
        ...info,
        waitMinutes: 1,
      },
    );
  }
  if (httpStatus >= 500) return TIKTOK_ERRORS.unavailable(call, "server", httpStatus);
  return error(
    "TIKTOK_REQUEST_REJECTED",
    `TikTok rechazó el pedido (${tiktokCode ?? httpStatus})`,
    false,
    info,
  );
}

/**
 * Si TikTok rechazó el `access_token` en una llamada (`access_token_invalid`): el publisher pide
 * otro con el rechazado (`rejectedToken`) y repite **una** vez.
 */
export const isTikTokTokenRejected = (caught: unknown): boolean =>
  isAppError(caught) &&
  caught.code === "TIKTOK_AUTH_INVALID" &&
  caught.details?.reason === "access_token_invalid";

/**
 * Si la renovación falló porque TikTok ya no acepta el refresh token (`invalid_grant`): solo eso
 * deja la cuenta vencida (ADR-0029 punto 11); la red, el tope o el par de la app no.
 */
export const isTikTokRefreshRejected = (caught: unknown): boolean =>
  isAppError(caught) &&
  caught.code === "TIKTOK_AUTH_INVALID" &&
  caught.details?.oauthError === "invalid_grant";
