import { AppError, isAppError } from "../errors.js";
import type { Listing } from "../listing.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { LockedRepositories } from "../ports/listing-lock.js";
import type { Publication, PublicationActor } from "../publication.js";

// Piezas comunes de publicar el canal (`publishListing`), publicar una (`startPublication`),
// descartar y retirar (spec F3 §4.3).

/** Estados del aviso en que se puede publicar (spec F3 §4.3): listo o ya publicado. */
const PUBLISHABLE_LISTING_STATUSES: readonly Listing["status"][] = ["ready", "active"];
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
  if (!PUBLISHABLE_LISTING_STATUSES.includes(listing.status)) {
    throw new AppError(
      "LISTING_NOT_READY",
      "La propiedad tiene que estar lista o publicada para publicar",
      { details: { listingId, status: listing.status } },
    );
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
  if (dryRun && !publication.dryRun && publication.progress !== null) {
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
