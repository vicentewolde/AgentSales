import type { PlatformAccountStatus } from "../enums.js";

/**
 * Cuánto espera la CLI (y el panel) el resultado de un inicio de sesión de Marketplace: los 10 min
 * que el worker espera la sesión, más el turno del perfil (hasta 30 s) y un margen.
 */
export const MARKETPLACE_LOGIN_CLIENT_WAIT_MS = 11 * 60_000;

/**
 * Por qué no se pudo iniciar sesión en Facebook (`meta.lastLoginError.code`, lo anota el worker en
 * el job `marketplace.profile`), en palabras del operador. Los códigos sin texto propio usan el
 * genérico.
 */
const LOGIN_ERROR_TEXT: Readonly<Record<string, string>> = {
  MARKETPLACE_LOGIN_TIMEOUT: "Pasaron 10 minutos sin que se iniciara la sesión en Facebook",
  MARKETPLACE_WINDOW_CLOSED: "Se cerró la ventana de Chromium antes de iniciar la sesión",
  MARKETPLACE_LOGIN_ABORTED: "El worker se detuvo mientras esperaba el inicio de sesión",
  MARKETPLACE_PROFILE_BUSY:
    "El perfil de Facebook estaba ocupado (otra ventana de Marketplace abierta, o pnpm fb:smoke)",
  MARKETPLACE_BROWSER_NOT_INSTALLED:
    "No se encontró Chromium: instálalo con pnpm --filter @agentsales/media exec playwright install chromium",
  MARKETPLACE_BROWSER_FAILED: "Chromium no pudo abrir la ventana de Facebook",
  MARKETPLACE_SESSION_ID_INVALID: "La sesión de Facebook no trae el id de la cuenta esperado",
  MANUAL_CONFIRM_PENDING:
    "Iniciaste sesión con otra cuenta de Facebook, y la conectada tiene una publicación esperando tu clic final: di primero si la publicaste",
};

/** El texto de un error de inicio de sesión de Marketplace (la CLI y el panel). */
export function marketplaceLoginErrorText(code: string): string {
  return LOGIN_ERROR_TEXT[code] ?? `No se pudo iniciar sesión en Facebook (${code})`;
}

/** Lo que mira el resultado de un inicio de sesión de una cuenta (la vista de la API lo trae). */
export type MarketplaceLoginAccount = {
  brokerId: string;
  platform: string;
  status: PlatformAccountStatus;
  sessionCheckedAt: Date | null;
  lastLoginError: { code: string; at: Date } | null;
};

/**
 * El inicio de sesión que falló y sigue vigente (spec F5 §4.2): `lastLoginError` queda guardado
 * aunque después se conecte, así que solo cuenta si es más nuevo que la última sesión vista. Lo
 * muestran la lista de cuentas de la CLI y el panel.
 */
export function currentMarketplaceLoginError<E extends { at: Date }>(account: {
  sessionCheckedAt: Date | null;
  lastLoginError: E | null;
}): E | null {
  const error = account.lastLoginError;
  if (error === null) return null;
  if (account.sessionCheckedAt !== null && error.at.getTime() <= account.sessionCheckedAt.getTime())
    return null;
  return error;
}

/** En qué quedó un inicio de sesión pedido: conectado, falló (con su código) o sigue esperando. */
export type MarketplaceLoginOutcome =
  | { outcome: "connected" }
  | { outcome: "failed"; code: string }
  | { outcome: "pending" };

/**
 * ¿En qué quedó el inicio de sesión de Marketplace que se pidió en `requestedAt`? (spec F5 §4.2):
 * la CLI y el panel miran `GET /accounts` hasta que una cuenta de Marketplace del corredor tenga
 * la sesión revisada (`sessionCheckedAt`) o un error de inicio de sesión (`lastLoginError.at`)
 * desde el pedido. Gana lo más reciente; lo de antes del pedido no cuenta. Sin cuenta del corredor
 * (el primer inicio de sesión que falla no tiene dónde anotarse), sigue `pending` hasta el tope.
 */
export function marketplaceLoginOutcome(
  accounts: readonly MarketplaceLoginAccount[],
  { brokerId, requestedAt }: { brokerId: string; requestedAt: Date },
): MarketplaceLoginOutcome {
  const since = requestedAt.getTime();
  let connectedAt = -1;
  let failure: { code: string; at: number } | null = null;
  for (const account of accounts) {
    if (account.brokerId !== brokerId || account.platform !== "fb_marketplace") continue;
    const checked = account.sessionCheckedAt?.getTime() ?? -1;
    if (account.status === "connected" && checked >= since && checked > connectedAt) {
      connectedAt = checked;
    }
    const error = account.lastLoginError;
    if (error !== null && error.at.getTime() >= since) {
      if (failure === null || error.at.getTime() > failure.at) {
        failure = { code: error.code, at: error.at.getTime() };
      }
    }
  }
  if (failure !== null && failure.at > connectedAt)
    return { outcome: "failed", code: failure.code };
  if (connectedAt >= 0) return { outcome: "connected" };
  return { outcome: "pending" };
}
