import type { ContentView, PublicationView } from "@agentsales/api/contracts";
import {
  ACTIVE_PUBLICATION_STATUSES,
  canPrepareContent,
  LISTING_NOT_PREPARABLE_TEXT,
  type ListingStatus,
  PENDING_PUBLICATION_STATUSES,
  type PublishMode,
} from "@agentsales/core";

// Las reglas de la API (ADR-0014, spec F3 §4.2 y §4.3) vistas desde el panel: qué botón se puede
// usar y, si no, por qué. La API las vuelve a revisar al pedir; esto es para explicar antes.

const pending = new Set<string>(PENDING_PUBLICATION_STATUSES);
const active = new Set<string>(ACTIVE_PUBLICATION_STATUSES);

const hasErrors = (content: ContentView) =>
  content.checks.some((check) => check.severity === "error");

/** Por qué no se puede preparar el contenido de nuevo: hay publicaciones pendientes (D3). */
export function prepareBlockedReason(publications: readonly PublicationView[]): string | null {
  return publications.some((publication) => pending.has(publication.status))
    ? "Hay publicaciones aprobadas que no han salido: publícalas o descártalas antes de preparar de nuevo (cambiaría lo aprobado)."
    : null;
}

/** Por qué no se puede editar un texto: tiene una publicación activa (pendiente o publicada). */
export function editBlockedReason(
  content: ContentView,
  publications: readonly PublicationView[],
): string | null {
  return publications.some(
    (publication) => publication.contentId === content.id && active.has(publication.status),
  )
    ? "Este texto tiene publicaciones activas: es el registro de lo aprobado. Para cambiarlo, descarta o retira sus publicaciones."
    : null;
}

/** Por qué no se puede aprobar un texto (la API lo vuelve a revisar). */
export function approveBlockedReason(
  content: ContentView,
  listingStatus: ListingStatus,
  runActive: boolean,
): string | null {
  if (!canPrepareContent(listingStatus)) return `${LISTING_NOT_PREPARABLE_TEXT}.`;
  if (runActive) return "Se está preparando el contenido: espera a que termine.";
  if (hasErrors(content)) return "La revisión tiene errores: corrígelos para poder aprobar.";
  return null;
}

/** Por qué no se puede quitar la aprobación: una de sus publicaciones se está publicando. */
export function unapproveBlockedReason(
  content: ContentView,
  publications: readonly PublicationView[],
): string | null {
  return publications.some(
    (publication) => publication.contentId === content.id && publication.status === "publishing",
  )
    ? "Hay una publicación en curso: espera a que termine."
    : null;
}

/** Por qué no se puede publicar el canal (la API lo vuelve a revisar). */
export function publishBlockedReason(
  listingStatus: ListingStatus,
  runActive: boolean,
): string | null {
  if (listingStatus !== "ready" && listingStatus !== "active") {
    return "La propiedad tiene que estar lista o activa para publicar.";
  }
  if (runActive) return "Se está preparando el contenido: espera a que termine.";
  return null;
}

/**
 * Por qué no se puede reintentar una fallida: ya empezó en vivo en la plataforma y la API está en
 * simulación (`PUBLISH_MODE_LOCKED`): la simulación la daría por publicada sin saber si salió.
 */
export function retryBlockedReason(
  publication: PublicationView,
  publishMode: PublishMode | undefined,
): string | null {
  return publication.startedLive && publishMode === "dry-run"
    ? "Ya empezó en vivo en Instagram: reintenta con la API en vivo, o descártala."
    : null;
}

/** Qué se puede hacer con una publicación según su estado. */
export function publicationActions(publication: PublicationView) {
  return {
    retry: publication.status === "failed",
    cancel: publication.status === "approved" || publication.status === "failed",
    retire: publication.status === "published",
  };
}
