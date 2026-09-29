import type { PublicationStatus } from "./enums.js";
import { AppError } from "./errors.js";

/**
 * Transiciones permitidas de una publicación (docs/01-arquitectura.md).
 * `awaiting_manual_confirm` es el paso de Marketplace donde el operador hace el clic
 * final; pasa a `failed` si se detiene ante un captcha o el operador lo abandona (ADR-0004).
 */
export const PUBLICATION_TRANSITIONS: Readonly<
  Record<PublicationStatus, readonly PublicationStatus[]>
> = {
  draft: ["pending_approval"],
  pending_approval: ["approved", "draft"],
  approved: ["scheduled", "publishing"],
  scheduled: ["publishing"],
  publishing: ["published", "failed", "awaiting_manual_confirm"],
  awaiting_manual_confirm: ["published", "failed"],
  published: ["paused", "unpublished"],
  failed: ["publishing"],
  paused: ["published", "unpublished"],
  unpublished: [],
};

export function canTransition(from: PublicationStatus, to: PublicationStatus): boolean {
  return PUBLICATION_TRANSITIONS[from].includes(to);
}

/** Devuelve `to` si la transición es válida; si no, lanza `AppError("INVALID_TRANSITION")`. */
export function transition(from: PublicationStatus, to: PublicationStatus): PublicationStatus {
  if (!canTransition(from, to)) {
    throw new AppError("INVALID_TRANSITION", `Transición inválida de ${from} a ${to}`, {
      details: { from, to },
    });
  }
  return to;
}
