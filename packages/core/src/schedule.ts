import type { Platform, PublicationStatus } from "./enums.js";
import { AppError } from "./errors.js";
import { requiresManualConfirm } from "./marketplace/limits.js";

// Reglas puras del calendario (spec F6 §4.3 y §4.4, ADR-0018).

/** Lo mínimo que se puede programar hacia adelante: menos sería "publicar ahora". */
export const SCHEDULE_MIN_LEAD_MS = 2 * 60 * 1000;
/** Lo más lejos que se puede programar. */
export const SCHEDULE_MAX_AHEAD_MS = 60 * 24 * 60 * 60 * 1000;
/**
 * Con más atraso que esto, una programada no sale sola al encender el worker: espera la decisión
 * del operador (respuesta del operador, spec F6 D2).
 */
export const SCHEDULE_OVERDUE_MS = 12 * 60 * 60 * 1000;
/** El espaciado máximo entre propiedades de un lote, en minutos (spec F6 §4.3). */
export const MAX_SCHEDULE_SPACING_MINUTES = 240;

/**
 * La hora de una programación, al minuto (los segundos se descartan), revisada contra `now`: al
 * menos 2 min adelante (`SCHEDULE_TOO_SOON`) y como mucho 60 días (`SCHEDULE_TOO_FAR`). Una fecha
 * inválida es `SCHEDULE_AT_INVALID`. Los tres son no reintentables (400 en la API). Con `minLead`
 * en falso (el recordatorio de `auto_publish`) acepta `now` mismo.
 */
export function scheduleAt(at: Date, now: Date, { minLead = true } = {}): Date {
  if (Number.isNaN(at.getTime())) {
    throw new AppError("SCHEDULE_AT_INVALID", "La fecha y hora no son válidas");
  }
  const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  const earliest = minLead ? now.getTime() + SCHEDULE_MIN_LEAD_MS : now.getTime() - 60_000;
  if (minute.getTime() < earliest) {
    throw new AppError(
      "SCHEDULE_TOO_SOON",
      "La hora tiene que ser al menos 2 minutos en el futuro: para ahora, publica en vez de programar",
      { details: { at: minute.toISOString() } },
    );
  }
  if (minute.getTime() > now.getTime() + SCHEDULE_MAX_AHEAD_MS) {
    throw new AppError("SCHEDULE_TOO_FAR", "Se puede programar como mucho 60 días adelante", {
      details: { at: minute.toISOString() },
    });
  }
  return minute;
}

/**
 * En qué está una programada (para las vistas, spec F6 §4.4 y §4.9): `upcoming` (todavía no es la
 * hora), `due` (venció y sale en la próxima vuelta del disparo, o un recordatorio de Marketplace
 * que "te toca") u `overdue` (atrasada más de 12 h: espera al operador). `null` si no está
 * programada. Un recordatorio nunca está atrasado: el operador siempre lo aprieta él.
 */
export const SCHEDULE_STATES = ["upcoming", "due", "overdue"] as const;
export type ScheduleState = (typeof SCHEDULE_STATES)[number];

export function scheduleState(
  publication: { status: PublicationStatus; scheduledAt: Date | null; platform: Platform },
  now: Date,
): ScheduleState | null {
  if (publication.status !== "scheduled" || publication.scheduledAt === null) return null;
  const late = now.getTime() - publication.scheduledAt.getTime();
  if (late < 0) return "upcoming";
  if (requiresManualConfirm(publication.platform)) return "due";
  return late > SCHEDULE_OVERDUE_MS ? "overdue" : "due";
}
