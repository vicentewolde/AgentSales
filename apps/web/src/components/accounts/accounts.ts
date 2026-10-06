import {
  OAUTH_REDIRECT_ERRORS,
  type OAuthRedirectError,
  type PlatformAccountView,
} from "@agentsales/api/contracts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Con 10 días o menos de vigencia, se avisa (spec F3 §4.6). */
export const EXPIRY_WARNING_DAYS = 10;

/** Por qué el OAuth volvió con `?error=` (los códigos del contrato y los de Instagram). */
const OAUTH_ERROR_TEXT: Readonly<Record<OAuthRedirectError, string>> = {
  OAUTH_DENIED: "Rechazaste los permisos en Instagram: no se conectó nada.",
  OAUTH_STATE_INVALID:
    "El enlace de conexión venció o se abrió desde otra pestaña: vuelve a conectar.",
  OAUTH_CODE_MISSING: "Instagram no devolvió el código de conexión: vuelve a conectar.",
  INSTAGRAM_NOT_CONFIGURED:
    "A la API le faltan INSTAGRAM_APP_ID e INSTAGRAM_APP_SECRET en el .env: agrégalos y reiníciala.",
  BROKER_NOT_FOUND: "El corredor del enlace no existe: vuelve a conectar desde esta página.",
  INTERNAL_ERROR: "La conexión falló por un error interno: revisa el log de la API.",
};

const INSTAGRAM_ERROR_TEXT: Readonly<Record<string, string>> = {
  IG_PERMISSION_DENIED:
    "No diste el permiso de publicar: vuelve a conectar y acepta todos los permisos.",
  IG_AUTH_INVALID:
    "Instagram no aceptó la conexión (el código venció o ya se usó): vuelve a conectar.",
  IG_UNAVAILABLE: "Instagram no respondió: vuelve a intentarlo en unos minutos.",
};

const isOAuthError = (code: string): code is OAuthRedirectError =>
  (OAUTH_REDIRECT_ERRORS as readonly string[]).includes(code);

/**
 * El texto de un `?error=` de la URL. Viene de la barra de direcciones (cualquiera puede escribirlo):
 * un código desconocido se nombra solo si tiene la forma de un código, y si no, no se muestra.
 */
export function oauthErrorText(code: string): string {
  if (isOAuthError(code)) return OAUTH_ERROR_TEXT[code];
  const known = INSTAGRAM_ERROR_TEXT[code];
  if (known !== undefined) return known;
  return /^[A-Z_]{1,64}$/.test(code)
    ? `No se pudo conectar Instagram (${code}).`
    : "No se pudo conectar Instagram.";
}

/** Una fecha en hora de Chile, como la muestran la CLI y el resto del panel. */
export const accountDateText = (date: Date) =>
  date.toLocaleDateString("es-CL", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "America/Santiago",
  });

export type ExpiryState =
  | { kind: "unknown" }
  | { kind: "inactive" }
  | { kind: "expired" }
  | { kind: "soon"; days: number }
  | { kind: "ok"; days: number };

/**
 * Cuánto le queda a una cuenta conectada: `expired` si ya pasó la fecha, `soon` con 10 días o menos
 * (redondeado hacia arriba: con medio día, "1 día"). Una cuenta no conectada no avisa (`inactive`).
 */
export function expiryState(account: PlatformAccountView, now: Date): ExpiryState {
  if (account.tokenExpiresAt === null) return { kind: "unknown" };
  if (account.status !== "connected") return { kind: "inactive" };
  const left = account.tokenExpiresAt.getTime() - now.getTime();
  if (left <= 0) return { kind: "expired" };
  const days = Math.ceil(left / DAY_MS);
  return days <= EXPIRY_WARNING_DAYS ? { kind: "soon", days } : { kind: "ok", days };
}

/** Las cuentas que se muestran: las que no están desconectadas o, si no hay, la última desconectada. */
export function visibleAccounts(accounts: readonly PlatformAccountView[]): PlatformAccountView[] {
  const active = accounts.filter((account) => account.status !== "revoked");
  if (active.length > 0) return active;
  // La que cambió más recientemente (la API no promete un orden).
  const last = [...accounts].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  return last === undefined ? [] : [last];
}
