import { LISTING_PLATFORMS, type ListingPlatform, type PublicationFormat } from "../enums.js";
import type { Listing } from "../listing.js";
import { type PortalExpiry, portalExpiry } from "../portal/expiry.js";
import type { Publication, PublicationError } from "../publication.js";
import { publicationErrorAdvice } from "../publish/error-advice.js";
import { type ScheduleState, scheduleState } from "../schedule.js";
import { isManualTask } from "./manual-tasks.js";

// La matriz de seguimiento (spec F6 §4.9): una fila por propiedad y una celda por plataforma.

/** Una publicación tal como la muestra la matriz. */
export type TrackingPublication = {
  id: string;
  format: PublicationFormat;
  status: Publication["status"];
  dryRun: boolean;
  /** Solo `https` (el panel lo vuelve enlace). */
  externalUrl: string | null;
  scheduledAt: Date | null;
  /** En qué está una programada (`upcoming`, `due`, `overdue`); `null` si no está programada. */
  schedule: ScheduleState | null;
  /** Portal: el vencimiento de su aviso; `null` sin dato. */
  expiry: PortalExpiry | null;
  /** El último error y qué hacer con él (`publicationErrorAdvice`), como la vista de la API. */
  lastError: PublicationError | null;
  errorAdvice: string | null;
  /** Instagram o Marketplace en vivo de una propiedad cerrada: el operador lo borra a mano. */
  manualTask: boolean;
  updatedAt: Date;
};

export type TrackingRow = {
  listing: Pick<
    Listing,
    | "id"
    | "brokerId"
    | "externalRef"
    | "status"
    | "closeReason"
    | "operation"
    | "propertyType"
    | "comuna"
  >;
  /** Por plataforma, la publicación más reciente de cada formato (en el orden de `PUBLICATION_FORMATS`). */
  cells: Record<ListingPlatform, TrackingPublication[]>;
};

const httpsOrNull = (url: string | null) => (url?.startsWith("https://") ? url : null);

/** La vista de una publicación para la matriz y la agenda. */
export function trackingPublication(
  listing: Pick<Listing, "status">,
  publication: Publication,
  now: Date,
): TrackingPublication {
  return {
    id: publication.id,
    format: publication.format,
    status: publication.status,
    dryRun: publication.dryRun,
    externalUrl: httpsOrNull(publication.externalUrl),
    scheduledAt: publication.scheduledAt,
    schedule: scheduleState(publication, now),
    expiry:
      publication.platform === "portal_inmobiliario"
        ? portalExpiry(publication.remoteState, now)
        : null,
    lastError: publication.lastError,
    errorAdvice:
      publication.lastError === null ? null : publicationErrorAdvice(publication.lastError.code),
    manualTask: isManualTask(listing.status, publication),
    updatedAt: publication.updatedAt,
  };
}

/**
 * La fila de una propiedad (`trackingRow`, pura): por plataforma, la publicación más reciente de
 * cada formato entre las que trae `listForTracking` (las activas y las terminadas de los últimos 30
 * días). Las de otra propiedad se ignoran.
 */
export function trackingRow(
  listing: TrackingRow["listing"],
  publications: readonly Publication[],
  now: Date,
): TrackingRow {
  const latest = new Map<string, Publication>();
  for (const publication of publications) {
    if (publication.listingId !== listing.id) continue;
    const key = `${publication.platform}:${publication.format}`;
    const current = latest.get(key);
    if (current === undefined || publication.createdAt.getTime() > current.createdAt.getTime()) {
      latest.set(key, publication);
    }
  }
  const cells = Object.fromEntries(
    LISTING_PLATFORMS.map((platform) => [
      platform,
      [...latest.values()]
        .filter((publication) => publication.platform === platform)
        .sort((a, b) => a.format.localeCompare(b.format))
        .map((publication) => trackingPublication(listing, publication, now)),
    ]),
  ) as Record<ListingPlatform, TrackingPublication[]>;
  return {
    listing: {
      id: listing.id,
      brokerId: listing.brokerId,
      externalRef: listing.externalRef,
      status: listing.status,
      closeReason: listing.closeReason,
      operation: listing.operation,
      propertyType: listing.propertyType,
      comuna: listing.comuna,
    },
    cells,
  };
}
