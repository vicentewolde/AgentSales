import { AppError } from "../errors.js";
import type { ListingLock } from "../ports/listing-lock.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import type { Publication, PublicationActor } from "../publication.js";
import { publicationNotFound } from "./publish-listing.js";

export type RetirePublicationDeps = {
  lock: ListingLock;
  /** Fuera del candado: solo para saber de qué aviso es la publicación. */
  publications: Pick<PublicationRepository, "get">;
};

export type RetiredPublication = {
  publication: Publication;
  /** `true` si era la última publicada en `live` y el aviso volvió de `active` a `ready`. */
  listingBackToReady: boolean;
};

/**
 * Marca como retirada una publicación (spec F3 §4.3 y D8, `POST /publications/:id/retire`):
 * `published` → `unpublished`, con su evento, dentro del candado del aviso. Con Instagram Login no
 * se puede borrar por la API, así que en `live` el operador confirma que la borró a mano
 * (`removedByHand`); en `dry-run` no hay nada que borrar. Si era la última publicada en `live` del
 * aviso, el aviso vuelve de `active` a `ready` (cambio del sistema, condicional: si el aviso ya
 * cambió, no se toca). Errores (`AppError`):
 * - no existe → `PUBLICATION_NOT_FOUND` (404);
 * - en `live` sin la confirmación → `REMOVAL_NOT_CONFIRMED` (409), sin cambiar nada;
 * - no está publicada → `INVALID_TRANSITION` (409).
 */
export async function retirePublication(
  deps: RetirePublicationDeps,
  {
    publicationId,
    actor,
    removedByHand = false,
  }: { publicationId: string; actor: PublicationActor; removedByHand?: boolean },
): Promise<RetiredPublication> {
  const found = await deps.publications.get(publicationId);
  if (found === null) throw publicationNotFound(publicationId);

  return deps.lock.run(found.listingId, async (locked) => {
    const publication = await locked.publications.get(publicationId);
    if (publication === null) throw publicationNotFound(publicationId);
    if (publication.status !== "published") {
      throw new AppError("INVALID_TRANSITION", "Solo se retira una publicación publicada", {
        details: { publicationId, from: publication.status, to: "unpublished" },
      });
    }
    const live = !publication.dryRun;
    if (live && !removedByHand) {
      throw new AppError(
        "REMOVAL_NOT_CONFIRMED",
        "Bórrala a mano en Instagram y confirma que lo hiciste antes de marcarla como retirada",
        { details: { publicationId } },
      );
    }
    const retired = await locked.publications.transition(
      publicationId,
      { from: "published", to: "unpublished" },
      { actor, payload: { mode: live ? "live" : "dry-run", removedByHand: live } },
    );
    let listingBackToReady = false;
    if (live) {
      const stillLive = (await locked.publications.listByListing(publication.listingId)).some(
        (other) => !other.dryRun && (other.status === "published" || other.status === "paused"),
      );
      if (!stillLive) {
        listingBackToReady = await locked.listings.changeStatus(
          publication.listingId,
          "active",
          "ready",
        );
      }
    }
    return { publication: retired, listingBackToReady };
  });
}
