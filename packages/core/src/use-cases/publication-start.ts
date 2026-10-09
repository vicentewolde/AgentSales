import { hasContentErrors } from "../content/check.js";
import { checked, loadCheckContext } from "../content/check-context.js";
import type { Content } from "../content.js";
import type { Platform } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import type { FieldDefinition } from "../field-definition.js";
import { LISTING_NOT_PUBLISHABLE_TEXT } from "../labels.js";
import { canPublishListing, type Listing } from "../listing.js";
import { portalReadiness } from "../portal/readiness.js";
import type { FieldDefinitionRepository } from "../ports/field-definition-repository.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { LockedRepositories } from "../ports/listing-lock.js";
import type { ListingRepository } from "../ports/listing-repository.js";
import { hasStartedLive, type Publication, type PublicationActor } from "../publication.js";

// Piezas comunes de publicar el canal (`publishListing`), publicar una (`startPublication`),
// descartar y retirar (spec F3 §4.3).

/** Estados de una publicación que se pueden pasar a `publishing`. */
export const STARTABLE_STATUSES: readonly Publication["status"][] = ["approved", "failed"];

export const publicationNotFound = (publicationId: string) =>
  new AppError("PUBLICATION_NOT_FOUND", `No existe la publicación ${publicationId}`, {
    details: { publicationId },
  });

/** El modo de un intento para la bitácora (`publication_events`). */
export const modeOf = (dryRun: boolean) => (dryRun ? "dry-run" : "live");

/**
 * Encola el intento de una publicación. Con `singletonKey` (cola `exclusive`) es idempotente: lo
 * usan publicar, publicar una y el worker, que reencola todas las `publishing` al arrancar. `null`
 * = ya había un job de esa publicación en la cola o en curso, que la va a procesar.
 */
export const enqueuePublication = (queue: JobQueue, publicationId: string) =>
  queue.enqueue("publication.publish", { publicationId }, { singletonKey: publicationId });

/**
 * Encola todas, aunque alguna falle: así ninguna queda sin intentar. Si la cola no está, lanza el
 * primer error con las que quedaron sin job en `details.publicationIds` (siguen en `publishing`;
 * publicar el canal de nuevo, o el worker al arrancar, las reencola).
 */
export async function enqueuePublications(
  queue: JobQueue,
  publications: readonly Publication[],
): Promise<void> {
  const failed: string[] = [];
  let first: unknown;
  for (const publication of publications) {
    try {
      await enqueuePublication(queue, publication.id);
    } catch (error) {
      failed.push(publication.id);
      first ??= error;
    }
  }
  if (first === undefined) return;
  if (isAppError(first)) {
    throw new AppError(first.code, first.message, {
      retriable: first.retriable,
      details: { ...first.details, publicationIds: failed },
      cause: first,
    });
  }
  throw first;
}

export function requirePublishableListing(listing: Listing | null, listingId: string): Listing {
  if (listing === null) {
    throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${listingId}`, {
      details: { listingId },
    });
  }
  if (!canPublishListing(listing.status)) {
    throw new AppError("LISTING_NOT_READY", LISTING_NOT_PUBLISHABLE_TEXT, {
      details: { listingId, status: listing.status },
    });
  }
  return listing;
}

/** Sin corridas activas: una corrida puede reemplazar los medios (spec F3 §4.2). */
export async function requireNoActiveRun(
  locked: Pick<LockedRepositories, "contentRuns">,
  listingId: string,
): Promise<void> {
  const active = await locked.contentRuns.findActive(listingId);
  if (active !== null) {
    throw new AppError(
      "CONTENT_RUN_ACTIVE",
      "Hay una preparación de contenido en curso: espera a que termine para publicar",
      { details: { listingId, contentRunId: active.id } },
    );
  }
}

/**
 * Un intento que ya empezó en `live` (tiene progreso en la plataforma) no se reintenta en
 * `dry-run`: la simulación lo daría por publicado sin saber si el medio real salió (D11).
 * `PUBLISH_MODE_LOCKED` (409): se reintenta en `live` o se descarta.
 */
export function requireCompatibleMode(publication: Publication, dryRun: boolean): void {
  if (dryRun && hasStartedLive(publication)) {
    throw new AppError(
      "PUBLISH_MODE_LOCKED",
      "Esta publicación ya empezó en vivo en la plataforma: reintenta en vivo o descártala",
      { details: { publicationId: publication.id } },
    );
  }
}

/**
 * Pasa una publicación a `publishing` con el modo de la API y su evento (spec F3 §4.3, D11):
 * `attempts` cuenta las veces que se pidió publicarla (los reintentos de la cola no lo suben); el
 * motivo del intento anterior se borra y `progress` se conserva para retomar.
 */
export function startOne(
  publications: LockedRepositories["publications"],
  publication: Publication,
  { dryRun, actor }: { dryRun: boolean; actor: PublicationActor },
): Promise<Publication> {
  return publications.transition(
    publication.id,
    {
      from: publication.status,
      to: "publishing",
      changes: { dryRun, incrementAttempts: true, lastError: null },
    },
    { actor, payload: { mode: modeOf(dryRun), attempt: publication.attempts + 1 } },
  );
}

/** Lo que se lee **antes** del candado para revisar un canal de Portal (spec F4 §4.5 y T16). */
export type PortalCheckDeps = {
  listings: Pick<ListingRepository, "get">;
  /** `LockedRepositories` no los trae: se leen fuera, antes de `run` (como al aprobar). */
  fieldDefinitions: Pick<FieldDefinitionRepository, "list">;
};

/**
 * Las definiciones de campos para revisar el texto de Portal antes de publicar, leídas antes del
 * candado; `null` si el canal no es Portal (Instagram no cambia). Un aviso que no existe da `[]`:
 * el candado lo rechaza después (`LISTING_NOT_FOUND`).
 */
export async function portalDefinitionsBeforeLock(
  deps: PortalCheckDeps,
  listingId: string,
  platform: Platform,
): Promise<FieldDefinition[] | null> {
  if (platform !== "portal_inmobiliario") return null;
  const listing = await deps.listings.get(listingId);
  if (listing === null) return [];
  return deps.fieldDefinitions.list({ category: listing.category, brokerId: listing.brokerId });
}

/**
 * Antes de pasar una publicación de Portal a `publishing` (spec F4 §4.5 y T16), dentro del candado:
 * 1. vuelve a revisar el texto aprobado: una regla nueva (F4-T12) pudo marcar un error en un texto
 *    aprobado antes, y no debe llegar a Mercado Libre a gastar un cupo → `CONTENT_HAS_ERRORS`;
 * 2. revisa que el aviso tenga lo que pide Portal (`portalReadiness`) → `PORTAL_NOT_READY`, con lo
 *    que falta en `details.issues` (`code`, `field` y `message`).
 * Los dos son no reintentables (409 en la API).
 */
export async function requirePortalPublishable(
  locked: Pick<LockedRepositories, "listings" | "brokers">,
  {
    listing,
    content,
    definitions,
  }: { listing: Listing; content: Content; definitions: readonly FieldDefinition[] },
): Promise<void> {
  const { broker, ctx } = await loadCheckContext(
    {
      listings: locked.listings,
      brokers: locked.brokers,
      fieldDefinitions: { list: async () => [...definitions] },
    },
    listing.id,
  );
  const review = checked(content, ctx);
  if (hasContentErrors(review.checks)) {
    throw new AppError(
      "CONTENT_HAS_ERRORS",
      "La revisión encontró errores en el texto aprobado: quita la aprobación, corrígelo y apruébalo de nuevo",
      {
        details: {
          contentId: content.id,
          codes: review.checks
            .filter((check) => check.severity === "error")
            .map((check) => check.code),
        },
      },
    );
  }
  const readiness = portalReadiness(listing, {
    name: broker.name,
    email: broker.email,
    whatsapp: broker.whatsapp,
  });
  if (!readiness.ready) {
    throw new AppError(
      "PORTAL_NOT_READY",
      `Falta información para publicar en Portal Inmobiliario: ${readiness.issues
        .map((issue) => issue.message)
        .join("; ")}`,
      { details: { listingId: listing.id, issues: readiness.issues } },
    );
  }
}

/**
 * En las plataformas que publican el aviso (`PUBLISH_LISTING_PLATFORMS`: Portal y, en F5,
 * Marketplace; spec F4 §4.6), una publicación que ya existía
 * (`failed` o `approved`) tiene que tener la versión del aviso de hoy: si una carga del Excel lo
 * cambió, `PUBLICATION_LISTING_CHANGED` (409) **antes** de pasarla a `publishing`, en vez de que
 * falle en el worker (desde F4-T19). La versión se lee dentro del candado.
 */
export async function requireCurrentListingVersion(
  locked: Pick<LockedRepositories, "listings">,
  listingId: string,
  publications: readonly Publication[],
): Promise<void> {
  if (publications.length === 0) return;
  const current = await locked.listings.getSourceHash(listingId);
  // Sin versión también es "cambió", como en el intento (`buildPublishInput`): la API y el worker
  // dicen lo mismo.
  const changed = publications.find(
    (publication) =>
      publication.listingSourceHash === null || publication.listingSourceHash !== current,
  );
  if (changed !== undefined) {
    throw new AppError(
      "PUBLICATION_LISTING_CHANGED",
      "El aviso cambió desde que se aprobó el texto (por ejemplo, una carga del Excel): descarta la publicación y aprueba de nuevo",
      {
        details: {
          publicationId: changed.id,
          reason: changed.listingSourceHash === null ? "missing_version" : "changed",
        },
      },
    );
  }
}
