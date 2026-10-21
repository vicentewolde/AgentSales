import type { Platform } from "../enums.js";
import { dateIn, MARKETPLACE_TIME_ZONE } from "../marketplace/limits.js";
import { accountTokenNeverExpires, type PlatformAccount } from "../platform-account.js";

// "Token por vencer" (spec F9 §4.7): las cuentas cuyo token vence y no se renueva solo.

/**
 * Las plataformas cuyo token vence y **no se renueva solo**: LinkedIn da un token de 60 días sin
 * refresco (spec F9 §4.6), así que el operador reconecta cada dos meses. Instagram y Mercado Libre
 * se renuevan con el job `tokens.refresh`; X y TikTok, con su refresh token al publicar; Discord es
 * un webhook y Marketplace una sesión del navegador.
 */
export const NON_RENEWING_TOKEN_PLATFORMS = ["linkedin"] as const satisfies readonly Platform[];

/** Con estos días o menos para el vencimiento, la agenda avisa (spec F9 §4.7, como Portal). */
export const TOKEN_EXPIRY_NOTICE_DAYS = 7;

export type AccountTokenExpiry = {
  expiresAt: Date;
  /** Días de calendario (hora de Chile) que le quedan; 0 si vence hoy, negativo si ya pasó. */
  daysLeft: number;
  /** Ya venció: pasó `token_expires_at` o la cuenta quedó `expired`. */
  expired: boolean;
  /** Vence en `TOKEN_EXPIRY_NOTICE_DAYS` días o menos y todavía no venció. */
  soon: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

/**
 * El vencimiento del token de una cuenta que no se renueva sola (pura). `null` si la plataforma se
 * renueva sola, si el token no vence (`meta.tokenNeverExpires`), si no se sabe cuándo vence
 * (`tokenExpiresAt = null`) o si la cuenta está desconectada o con otro problema (`revoked`,
 * `error`: eso lo dice Cuentas, no la agenda).
 */
export function accountTokenExpiry(
  account: Pick<PlatformAccount, "platform" | "status" | "tokenExpiresAt" | "meta">,
  now: Date,
): AccountTokenExpiry | null {
  if (!(NON_RENEWING_TOKEN_PLATFORMS as readonly Platform[]).includes(account.platform)) {
    return null;
  }
  if (accountTokenNeverExpires(account) || account.tokenExpiresAt === null) return null;
  if (account.status !== "connected" && account.status !== "expired") return null;
  const expiresAt = account.tokenExpiresAt;
  const daysLeft =
    dayNumber(dateIn(MARKETPLACE_TIME_ZONE, expiresAt)) -
    dayNumber(dateIn(MARKETPLACE_TIME_ZONE, now));
  const expired = account.status === "expired" || expiresAt.getTime() <= now.getTime();
  return { expiresAt, daysLeft, expired, soon: !expired && daysLeft <= TOKEN_EXPIRY_NOTICE_DAYS };
}
