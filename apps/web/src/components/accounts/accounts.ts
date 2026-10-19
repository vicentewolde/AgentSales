import {
  OAUTH_REDIRECT_ERRORS,
  type OAuthProvider,
  type OAuthRedirectError,
  type PlatformAccountView,
} from "@agentsales/api/contracts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Con 10 días o menos de vigencia, se avisa (spec F3 §4.6). */
export const EXPIRY_WARNING_DAYS = 10;

/** El nombre del proveedor del OAuth, como lo lee el operador. */
export const PROVIDER_NAME: Readonly<Record<OAuthProvider, string>> = {
  instagram: "Instagram",
  mercadolibre: "Mercado Libre",
};

/** Por qué el OAuth volvió con `?error=` (los códigos del contrato; `{proveedor}` es Instagram o Mercado Libre). */
const OAUTH_ERROR_TEXT: Readonly<Record<OAuthRedirectError, string>> = {
  OAUTH_DENIED: "Rechazaste los permisos en {proveedor}: no se conectó nada.",
  OAUTH_STATE_INVALID:
    "El enlace de conexión venció o se abrió desde otra pestaña: vuelve a conectar.",
  OAUTH_CODE_MISSING: "{proveedor} no devolvió el código de conexión: vuelve a conectar.",
  INSTAGRAM_NOT_CONFIGURED:
    "A la API le faltan INSTAGRAM_APP_ID e INSTAGRAM_APP_SECRET en el .env: agrégalos y reiníciala.",
  MERCADOLIBRE_NOT_CONFIGURED:
    "A la API le faltan ML_APP_ID y ML_CLIENT_SECRET: agrégalos y reiníciala.",
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

const MERCADOLIBRE_ERROR_TEXT: Readonly<Record<string, string>> = {
  ML_AUTH_INVALID:
    "Mercado Libre no aceptó la conexión (el código venció o ya se usó): vuelve a conectar.",
  ML_PERMISSION_DENIED:
    "No diste todos los permisos (publicar y mantener la conexión): vuelve a conectar y acéptalos.",
  ML_SITE_MISMATCH: "Esa cuenta de Mercado Libre no es de Chile: conecta una cuenta de Chile.",
  ML_REQUEST_REJECTED:
    "Mercado Libre rechazó la conexión: revisa que la dirección de vuelta registrada en su app sea la de este servidor.",
  ML_UNAVAILABLE: "Mercado Libre no respondió: vuelve a intentarlo en unos minutos.",
};

const PROVIDER_ERROR_TEXT: Readonly<Record<OAuthProvider, Readonly<Record<string, string>>>> = {
  instagram: INSTAGRAM_ERROR_TEXT,
  mercadolibre: MERCADOLIBRE_ERROR_TEXT,
};

const isOAuthError = (code: string): code is OAuthRedirectError =>
  (OAUTH_REDIRECT_ERRORS as readonly string[]).includes(code);

/**
 * El texto de un `?error=` de la URL. Viene de la barra de direcciones (cualquiera puede escribirlo):
 * un código desconocido se nombra solo si tiene la forma de un código, y si no, no se muestra.
 */
export function oauthErrorText(code: string, provider: OAuthProvider = "instagram"): string {
  const name = PROVIDER_NAME[provider];
  if (isOAuthError(code)) return OAUTH_ERROR_TEXT[code].replaceAll("{proveedor}", name);
  const known = PROVIDER_ERROR_TEXT[provider][code];
  if (known !== undefined) return known;
  return /^[A-Z_]{1,64}$/.test(code)
    ? `No se pudo conectar ${name} (${code}).`
    : `No se pudo conectar ${name}.`;
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
