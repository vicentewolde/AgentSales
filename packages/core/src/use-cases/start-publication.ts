import { AppError } from "../errors.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { ListingLock } from "../ports/listing-lock.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import type { Publication, PublicationActor } from "../publication.js";
import {
  enqueuePublications,
  type PortalCheckDeps,
  portalDefinitionsBeforeLock,
  publicationNotFound,
  requireCompatibleMode,
  requireCurrentListingVersion,
  requireNoActiveRun,
  requirePortalPublishable,
  requirePublishableListing,
  STARTABLE_STATUSES,
  startOne,
} from "./publication-start.js";

export type StartPublicationDeps = PortalCheckDeps & {
  lock: ListingLock;
  queue: JobQueue;
  /** Fuera del candado: solo para saber de qué aviso es la publicación. */
  publications: Pick<PublicationRepository, "get">;
};

export type StartPublicationResult = {
  publication: Publication;
  /** `true` si ya estaba en `publishing`: se reencoló sin cambiarla (conserva su modo). */
  requeued: boolean;
};

/**
 * Publica o reintenta **una** publicación (spec F3 §4.3, `POST /publications/:id/publish`):
 * - `approved` o `failed` → `publishing`, con el modo de la API (`dryRun`) y su evento; un
 *   reintento desde `failed` conserva `progress` (para no publicar dos veces);
 * - ya en `publishing` → la reencola sin cambiarla ni revisarla (`requeued`): un corte en el
 *   último intento la dejaba sin job, y el intento (T11) revisa todo al correr;
 * y encola después del candado. Revisa lo mismo que publicar el canal, sobre su propio texto (el
 * fijado al nacer, que no cambia mientras está pendiente: ADR-0014). Errores (`AppError`):
 * - no existe → `PUBLICATION_NOT_FOUND` (404); el aviso no está en `ready` o `active` → `LISTING_NOT_READY`;
 * - hay una corrida activa → `CONTENT_RUN_ACTIVE`; su texto ya no está aprobado → `CONTENT_NOT_APPROVED`;
 * - su cuenta ya no está conectada → `ACCOUNT_NOT_CONNECTED`;
 * - ya empezó en `live` y se pide en `dry-run` → `PUBLISH_MODE_LOCKED`;
 * - en Portal, el texto aprobado tiene errores según la revisión de hoy → `CONTENT_HAS_ERRORS`, o
 *   al aviso le falta lo que pide Portal → `PORTAL_NOT_READY` (spec F4 §4.5), o el aviso cambió
 *   desde que nació la publicación → `PUBLICATION_LISTING_CHANGED` (§4.6);
 * - ya está publicada → `NOTHING_TO_PUBLISH`; descartada o retirada → `INVALID_TRANSITION`;
 * - la cola no está → `QUEUE_UNAVAILABLE` (503): queda en `publishing` y se reencola pidiéndolo otra vez.
 */
export async function startPublication(
  deps: StartPublicationDeps,
  {
    publicationId,
    dryRun,
    actor,
  }: { publicationId: string; dryRun: boolean; actor: PublicationActor },
): Promise<StartPublicationResult> {
  const found = await deps.publications.get(publicationId);
  if (found === null) throw publicationNotFound(publicationId);
  const definitions = await portalDefinitionsBeforeLock(deps, found.listingId, found.platform);

  const result = await deps.lock.run(found.listingId, async (locked) => {
    const publication = await locked.publications.get(publicationId);
    if (publication === null) throw publicationNotFound(publicationId);
    if (publication.status === "publishing") return { publication, requeued: true };
    if (publication.status === "published") {
      throw new AppError("NOTHING_TO_PUBLISH", "Esta publicación ya está publicada", {
        details: { publicationId },
      });
    }
    if (!STARTABLE_STATUSES.includes(publication.status)) {
      throw new AppError(
        "INVALID_TRANSITION",
        "Esta publicación no se puede publicar: se descartó o se retiró",
        { details: { publicationId, from: publication.status, to: "publishing" } },
      );
    }
    const listing = requirePublishableListing(
      await locked.listings.get(publication.listingId),
      publication.listingId,
    );
    await requireNoActiveRun(locked, publication.listingId);
    const content = await locked.contents.get(publication.contentId);
    if (content === null || content.status !== "approved") {
      throw new AppError(
        "CONTENT_NOT_APPROVED",
        "El texto de esta publicación ya no está aprobado: apruébalo de nuevo o descártala",
        { details: { publicationId, contentId: publication.contentId } },
      );
    }
    const account = await locked.platformAccounts.get(publication.platformAccountId);
    if (account === null || account.status !== "connected") {
      throw new AppError(
        "ACCOUNT_NOT_CONNECTED",
        "La cuenta de esta publicación no está conectada: reconéctala o descártala",
        { details: { publicationId, accountStatus: account?.status ?? null } },
      );
    }
    requireCompatibleMode(publication, dryRun);
    if (definitions !== null) {
      await requirePortalPublishable(locked, { listing, content, definitions });
      await requireCurrentListingVersion(locked, listing.id, [publication]);
    }
    return {
      publication: await startOne(locked.publications, publication, { dryRun, actor }),
      requeued: false,
    };
  });

  await enqueuePublications(deps.queue, [result.publication]);
  return result;
}
