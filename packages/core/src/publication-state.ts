import { PUBLICATION_STATUSES, type PublicationStatus } from "./enums.js";
import { AppError } from "./errors.js";

/**
 * Transiciones permitidas de una publicación (docs/01-arquitectura.md).
 * - `awaiting_manual_confirm`: paso de Marketplace donde el operador hace el clic final;
 *   pasa a `failed` si se detiene ante un captcha o una verificación (ADR-0004).
 * - `cancelled`: la publicación nunca llegó a la plataforma (se descartó o se cerró el aviso).
 * - `unpublished`: estuvo publicada y se bajó.
 * Los reintentos automáticos no cambian de estado: la publicación sigue en `publishing`.
 */
export const PUBLICATION_TRANSITIONS: Readonly<
  Record<PublicationStatus, readonly PublicationStatus[]>
> = {
  draft: ["pending_approval", "cancelled"],
  pending_approval: ["approved", "draft", "cancelled"],
  approved: ["scheduled", "publishing", "cancelled"],
  scheduled: ["publishing", "cancelled"],
  publishing: ["published", "failed", "awaiting_manual_confirm"],
  awaiting_manual_confirm: ["published", "failed", "cancelled"],
  published: ["paused", "unpublished"],
  failed: ["publishing", "cancelled"],
  paused: ["published", "unpublished"],
  unpublished: [],
  cancelled: [],
};

/** Estados con los que se puede crear una publicación (`approved` solo con `auto_publish`). */
export const INITIAL_PUBLICATION_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
] as const satisfies readonly PublicationStatus[];

/** Estados finales: no tienen salidas. */
export const TERMINAL_PUBLICATION_STATUSES = [
  "unpublished",
  "cancelled",
] as const satisfies readonly PublicationStatus[];

/**
 * Estados que cuentan como "publicación activa" para el índice único parcial
 * `(listing_id, platform_account_id)` de `publications`: todos menos los terminales.
 */
const terminal: readonly PublicationStatus[] = TERMINAL_PUBLICATION_STATUSES;
export const ACTIVE_PUBLICATION_STATUSES: readonly PublicationStatus[] =
  PUBLICATION_STATUSES.filter((status) => !terminal.includes(status));

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
