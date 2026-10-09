import type { ContentView, PortalReadinessView, PublicationView } from "@agentsales/api/contracts";
import {
  ACTIVE_PUBLICATION_STATUSES,
  canPrepareContent,
  canPublishListing,
  hasContentErrors,
  LISTING_NOT_PREPARABLE_TEXT,
  LISTING_NOT_PUBLISHABLE_TEXT,
  type ListingStatus,
  PENDING_PUBLICATION_STATUSES,
  PLATFORM_TEXT,
  type Platform,
  type PublishMode,
} from "@agentsales/core";

// Las reglas de la API (ADR-0014, spec F3 §4.2 y §4.3) vistas desde el panel: qué botón se puede
// usar y, si no, por qué. La API las vuelve a revisar al pedir; esto es para explicar antes.

const pending = new Set<string>(PENDING_PUBLICATION_STATUSES);
const active = new Set<string>(ACTIVE_PUBLICATION_STATUSES);

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
  if (hasContentErrors(content.checks))
    return "La revisión tiene errores: corrígelos para poder aprobar.";
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
  if (!canPublishListing(listingStatus)) return `${LISTING_NOT_PUBLISHABLE_TEXT}.`;
  if (runActive) return "Se está preparando el contenido: espera a que termine.";
  return null;
}

/**
 * Por qué no se puede publicar en Portal además de lo común (spec F4-T22): un texto aprobado cuya
 * revisión (calculada al leer) tiene errores (`CONTENT_HAS_ERRORS`), o un aviso al que le falta algo
 * (`PORTAL_NOT_READY`). La API lo vuelve a revisar al publicar.
 */
export function portalPublishBlockedReason(
  content: ContentView | undefined,
  readiness: PortalReadinessView | null,
): string | null {
  if (content?.status === "approved" && hasContentErrors(content.checks)) {
    return "La revisión del texto tiene errores: quita la aprobación, corrígelo y vuelve a aprobarlo.";
  }
  if (readiness !== null && !readiness.ready) {
    return "Falta información para Portal (arriba): complétala en la planilla y vuelve a importarla.";
  }
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
    ? `Ya empezó en vivo en ${PLATFORM_TEXT[publication.platform]}: reintenta con la API en vivo, o descártala.`
    : null;
}

/**
 * Qué se puede hacer con una publicación según su estado y su canal. Un aviso de Portal no se
 * marca como retirado: se pausa, reactiva y cierra por la API, y Actualizar lee su estado allá
 * (solo en vivo: en simulación no hay nada que leer; spec F4 §4.9).
 */
export function publicationActions(publication: PublicationView) {
  const portal = publication.platform === "portal_inmobiliario";
  const { status } = publication;
  const onPlatform = status === "published" || status === "paused";
  return {
    retry: status === "failed",
    cancel: status === "approved" || status === "failed",
    retire: !portal && status === "published",
    pause: portal && status === "published",
    resume: portal && status === "paused",
    close: portal && onPlatform,
    sync: portal && onPlatform && !publication.dryRun,
  };
}

/**
 * Si pedir una publicación necesita confirmar que va en vivo: con la API en vivo y también mientras
 * no se sabe el modo (`/health` no respondió). Solo la simulación conocida no pregunta.
 */
export const needsLiveConfirm = (publishMode: PublishMode | undefined) => publishMode !== "dry-run";

/** El texto del botón Publicar según el canal y el modo de la API (neutro si todavía no se sabe). */
export function publishButtonText(
  platform: Platform,
  publishMode: PublishMode | undefined,
): string {
  const base = `Publicar en ${PLATFORM_TEXT[platform]}`;
  if (publishMode === "live") return `${base} (en vivo)`;
  if (publishMode === "dry-run") return `${base} (simulación)`;
  return base;
}

/**
 * Desde cuándo cuenta el tope de espera de una publicación (spec F3-T18): el más reciente entre su
 * último cambio y la hora del clic. Reencolar una que ya estaba en `publishing` no cambia
 * `updatedAt`, y una aprobada hace días no debe cortar la espera.
 */
export function waitStart(updatedAt: Date, requestedAt: Date | null): Date {
  return requestedAt !== null && requestedAt > updatedAt ? requestedAt : updatedAt;
}

/** El enlace de una publicada, solo si es `https` (viene de la API y va a un `href`). */
export function safeExternalUrl(url: string | null): string | null {
  return url?.startsWith("https://") ? url : null;
}
