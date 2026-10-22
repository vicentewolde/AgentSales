import {
  LANGUAGES,
  type Language,
  LISTING_PLATFORMS,
  type ListingPlatform,
  type ListingStatus,
  type Platform,
  POST_PLATFORMS,
  type PostPlatform,
  type PublicationFormat,
} from "../enums.js";
import type { Listing } from "../listing.js";
import { type PortalExpiry, portalExpiry } from "../portal/expiry.js";
import type { Post } from "../post.js";
import type { Publication, PublicationError } from "../publication.js";
import { publicationErrorAdvice } from "../publish/error-advice.js";
import { type ScheduleState, scheduleState } from "../schedule.js";
import { listingSubject, postSubject, type Subject, sameSubject } from "../subject.js";
import { isManualTask } from "./manual-tasks.js";

// La matriz de seguimiento (spec F6 §4.9): una fila por propiedad y una celda por plataforma. Desde
// F9-T08 (spec F9 §4.2), también una fila por post, con sus redes y el tema como título.

/** Una publicación tal como la muestra la matriz. */
export type TrackingPublication = {
  id: string;
  format: PublicationFormat;
  /** El idioma del texto (un post puede tener uno por idioma; un aviso, siempre `es`). */
  language: Language;
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
  /** Cuándo salió (F9.5-T03: «Publicado hace poco» en la portada); `null` si no salió. */
  publishedAt: Date | null;
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

/** La fila de un post (F9): el tema es su título, y una celda por red. */
export type TrackingPostRow = {
  post: Pick<Post, "id" | "brokerId" | "topic" | "status" | "kind" | "plannedAt">;
  /** Por red, la publicación más reciente de cada formato e idioma. */
  cells: Record<PostPlatform, TrackingPublication[]>;
};

const httpsOrNull = (url: string | null) => (url?.startsWith("https://") ? url : null);

/**
 * La vista de una publicación para la matriz y la agenda. `listingStatus` es el estado de su
 * propiedad (para la tarea a mano de una cerrada); `null` en un post.
 */
export function trackingPublication(
  listingStatus: ListingStatus | null,
  publication: Publication,
  now: Date,
): TrackingPublication {
  return {
    id: publication.id,
    format: publication.format,
    language: publication.language,
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
    manualTask: listingStatus !== null && isManualTask(listingStatus, publication),
    publishedAt: publication.publishedAt,
    updatedAt: publication.updatedAt,
  };
}

/**
 * Las celdas de un sujeto: por plataforma, la publicación más reciente de cada formato e idioma
 * entre las que trae `listForTracking`, ordenadas por formato y después idioma. Las de otro sujeto
 * se ignoran.
 */
function cellsOf<P extends Platform>(
  platforms: readonly P[],
  subject: Subject,
  listingStatus: ListingStatus | null,
  publications: readonly Publication[],
  now: Date,
): Record<P, TrackingPublication[]> {
  const latest = new Map<string, Publication>();
  for (const publication of publications) {
    if (!sameSubject(publication.subject, subject)) continue;
    const key = `${publication.platform}:${publication.format}:${publication.language}`;
    const current = latest.get(key);
    if (current === undefined || publication.createdAt.getTime() > current.createdAt.getTime()) {
      latest.set(key, publication);
    }
  }
  return Object.fromEntries(
    platforms.map((platform) => [
      platform,
      [...latest.values()]
        .filter((publication) => publication.platform === platform)
        .sort(
          (a, b) =>
            a.format.localeCompare(b.format) ||
            LANGUAGES.indexOf(a.language) - LANGUAGES.indexOf(b.language),
        )
        .map((publication) => trackingPublication(listingStatus, publication, now)),
    ]),
  ) as Record<P, TrackingPublication[]>;
}

/**
 * La fila de una propiedad (`trackingRow`, pura): por plataforma, la publicación más reciente de
 * cada formato entre las que trae `listForTracking` (las activas y las terminadas de los últimos 30
 * días). Las de otra propiedad (o de un post) se ignoran.
 */
export function trackingRow(
  listing: TrackingRow["listing"],
  publications: readonly Publication[],
  now: Date,
): TrackingRow {
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
    cells: cellsOf(
      LISTING_PLATFORMS,
      listingSubject(listing.id),
      listing.status,
      publications,
      now,
    ),
  };
}

/**
 * La fila de un post (`trackingPostRow`, pura, F9-T08): por red (`POST_PLATFORMS`), la publicación
 * más reciente de cada formato e idioma. Las de otro post (o de un aviso) se ignoran.
 */
export function trackingPostRow(
  post: TrackingPostRow["post"],
  publications: readonly Publication[],
  now: Date,
): TrackingPostRow {
  return {
    post: {
      id: post.id,
      brokerId: post.brokerId,
      topic: post.topic,
      status: post.status,
      kind: post.kind,
      plannedAt: post.plannedAt,
    },
    cells: cellsOf(POST_PLATFORMS, postSubject(post.id), null, publications, now),
  };
}
