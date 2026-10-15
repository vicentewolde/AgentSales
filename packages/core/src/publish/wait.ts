import type { AppError } from "../errors.js";
import type { PublicationEvent } from "../publication.js";

// La espera ante un límite de la plataforma (spec F6 §4.5, ADR-0018 punto 6): el intento, en vez de
// dejar la publicación `failed`, la reprograma para cuando se libere el límite. Core no nombra los
// códigos de ninguna plataforma: espera cuando el error trae la señal genérica `waitMinutes`.

/** Esperas seguidas como mucho; la siguiente deja la publicación `failed`. */
export const MAX_LIMIT_WAITS = 3;
/** Una señal más larga que esto se acorta: la regla de atrasadas (12 h) cubre lo demás. */
export const MAX_LIMIT_WAIT_MINUTES = 24 * 60;

/** Los minutos que pide esperar el error, o `null` si no es un límite que se espera. */
export function waitMinutesOf(error: AppError): number | null {
  const value = error.details?.waitMinutes;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(Math.ceil(value), MAX_LIMIT_WAIT_MINUTES);
}

/** La hora de reintentar: `now` más la espera, subida al minuto siguiente (el disparo es por minuto). */
export function retryAtAfter(now: Date, minutes: number): Date {
  return new Date(Math.ceil((now.getTime() + minutes * 60_000) / 60_000) * 60_000);
}

/**
 * Cuántas esperas seguidas lleva la publicación: los `status_changed` a `scheduled` con motivo
 * `rate_limit` desde el último paso del operador (un evento con otro actor que `system`, como
 * publicar ahora, reprogramar o reintentar). Cuenta el cambio de estado y no el `publish_attempt`
 * `rescheduled`: el cambio se guarda en la misma transacción que la espera, y el evento del intento
 * se escribe después y puede perderse.
 */
export function consecutiveLimitWaits(events: readonly PublicationEvent[]): number {
  let waits = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.actor !== "system") break;
    if (
      event.type === "status_changed" &&
      event.toStatus === "scheduled" &&
      event.payload.reason === "rate_limit"
    ) {
      waits += 1;
    }
  }
  return waits;
}
