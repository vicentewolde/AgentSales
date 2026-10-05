import type { Platform, PublicationFormat, PublicationStatus } from "../enums.js";
import type {
  Publication,
  PublicationActor,
  PublicationError,
  PublicationEvent,
  PublicationEventType,
} from "../publication.js";

/** Una publicación que nace (ADR-0014): siempre en `approved`, con su texto y sus medios fijos. */
export type NewPublication = {
  listingId: string;
  platformAccountId: string;
  platform: Platform;
  format: PublicationFormat;
  contentId: string;
  mediaIds: readonly string[];
  /** Modo provisional (el de la API al nacer); el definitivo se fija al pasar a `publishing`. */
  dryRun: boolean;
};

/** Quién causó un cambio y qué se anota en la bitácora (sin secretos: se guarda tal cual). */
export type PublicationEventInput = {
  actor: PublicationActor;
  payload?: Record<string, unknown>;
};

/** Campos que acompañan una transición; `undefined` = no tocar. */
export type PublicationChanges = {
  dryRun?: boolean;
  /** Suma 1 a `attempts` (al pasar a `publishing`). */
  incrementAttempts?: boolean;
  externalId?: string | null;
  externalUrl?: string | null;
  publishedAt?: Date | null;
  lastError?: PublicationError | null;
  /** Se valida con el esquema de su plataforma (`PUBLICATION_PROGRESS_SCHEMAS`). */
  progress?: unknown;
};

/** Un evento suelto de la bitácora (por ejemplo, `publish_attempt`), sin cambio de estado. */
export type NewPublicationEvent = PublicationEventInput & {
  type: Exclude<PublicationEventType, "status_changed">;
};

/**
 * Publicaciones y su bitácora (`publications` y `publication_events`, ADR-0014 y spec F3 §4.3).
 * Cada cambio de estado guarda la fila y su evento `status_changed` en una sola transacción, y es
 * condicional: solo si la publicación sigue en `from`. Errores (`AppError`):
 * - una segunda publicación activa del mismo aviso, cuenta y formato → `PUBLICATION_CONFLICT`;
 * - una publicación que no existe → `PUBLICATION_NOT_FOUND`;
 * - una transición que la máquina no permite, o desde un estado que ya cambió →
 *   `INVALID_TRANSITION` (sin escribir nada);
 * - un `progress` que no calza con el esquema de su plataforma → `PUBLICATION_PROGRESS_INVALID`;
 * - `saveProgress` fuera de `publishing` → `PUBLICATION_NOT_PUBLISHING`;
 * - una fila que no calza con la entidad → `PUBLICATION_ROW_INVALID` (o `PUBLICATION_EVENT_ROW_INVALID`);
 * - fallo de conexión → `DB_UNAVAILABLE`, reintentable.
 * Ninguno es reintentable salvo `DB_UNAVAILABLE`.
 */
export interface PublicationRepository {
  /** Crea la publicación en `approved` con su evento de nacimiento (`null` → `approved`). */
  create(publication: NewPublication, event: PublicationEventInput): Promise<Publication>;
  get(id: string): Promise<Publication | null>;
  /** Las de un aviso, por fecha de creación. */
  listByListing(listingId: string): Promise<Publication[]>;
  /** Las que están en un estado (por ejemplo, `publishing` para reencolarlas al arrancar). */
  listByStatus(status: PublicationStatus): Promise<Publication[]>;
  /**
   * Cambia el estado de `from` a `to` con los campos de `changes` y anota el evento, todo junto.
   * Devuelve la publicación ya cambiada.
   */
  transition(
    id: string,
    move: { from: PublicationStatus; to: PublicationStatus; changes?: PublicationChanges },
    event: PublicationEventInput,
  ): Promise<Publication>;
  /**
   * Guarda lo que el publisher ya creó en la plataforma, antes del paso que publica (spec F3 §4.4).
   * Solo con la publicación en `publishing`; `null` lo borra.
   */
  saveProgress(id: string, progress: unknown): Promise<Publication>;
  /** Anota un evento sin cambiar el estado (`publish_attempt`, `sync`, `manual_edit`). */
  addEvent(publicationId: string, event: NewPublicationEvent): Promise<PublicationEvent>;
  /** La bitácora de una publicación, de la más antigua a la más reciente. */
  listEvents(publicationId: string): Promise<PublicationEvent[]>;
}
