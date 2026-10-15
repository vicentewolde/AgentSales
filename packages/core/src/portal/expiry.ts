import { dateIn, MARKETPLACE_TIME_ZONE } from "../marketplace/limits.js";
import type { RemoteState } from "../publication.js";

/** Con estos días o menos para el vencimiento, la agenda y la tarjeta avisan (spec F6 §4.7, D10). */
export const PORTAL_EXPIRY_NOTICE_DAYS = 7;

export type PortalExpiry = {
  /** Fin de la vigencia del aviso (`stop_time` de Mercado Libre). */
  stopTime: Date;
  /** Días de calendario (hora de Chile) que le quedan; 0 si vence hoy, negativo si ya pasó. */
  daysLeft: number;
  /** Vence en 7 días o menos y todavía no venció. */
  soon: boolean;
  /** Ya venció: pasó `stop_time`, o Mercado Libre lo cerró como vencido. */
  expired: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

/**
 * El vencimiento de un aviso de Portal (spec F6 §4.7), puro: los días de calendario en hora de Chile
 * hasta su `stop_time` (un arriendo dura 45 días; una venta, 180). `null` sin estado remoto o sin
 * `stop_time`. Lo usan la agenda, la matriz y la tarjeta del aviso.
 */
export function portalExpiry(remote: RemoteState | null, now: Date): PortalExpiry | null {
  if (remote === null || remote.stopTime === null) return null;
  const stopTime = new Date(remote.stopTime);
  if (Number.isNaN(stopTime.getTime())) return null;
  const daysLeft =
    dayNumber(dateIn(MARKETPLACE_TIME_ZONE, stopTime)) -
    dayNumber(dateIn(MARKETPLACE_TIME_ZONE, now));
  const expired =
    stopTime.getTime() <= now.getTime() ||
    (remote.status === "closed" && remote.subStatus.includes("expired"));
  return {
    stopTime,
    daysLeft,
    soon: !expired && daysLeft <= PORTAL_EXPIRY_NOTICE_DAYS,
    expired,
  };
}
