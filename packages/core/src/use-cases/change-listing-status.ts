import type { ListingStatus } from "../enums.js";
import { AppError } from "../errors.js";
import { canChangeListingStatus, type Listing } from "../listing.js";
import type { ListingRepository } from "../ports/listing-repository.js";
import type { MediaRepository } from "../ports/media-repository.js";

export type ChangeListingStatusDeps = {
  listings: ListingRepository;
  media: MediaRepository;
};

const invalid = (listing: Listing, to: ListingStatus, message: string) =>
  new AppError("INVALID_TRANSITION", message, {
    details: { listingId: listing.id, from: listing.status, to },
  });

/**
 * Cambio manual del estado de un aviso (spec F1 §4.4, `PATCH /listings/:id/status`):
 * - solo los de `LISTING_MANUAL_TRANSITIONS`; otro es `INVALID_TRANSITION` (409);
 * - `ready` exige al menos una foto (un video no cuenta), también `INVALID_TRANSITION`;
 * - el cambio es condicional: si otro cambio llegó antes, `INVALID_TRANSITION`.
 * Un aviso que no existe es `LISTING_NOT_FOUND`. Devuelve el aviso ya cambiado.
 */
export async function changeListingStatus(
  deps: ChangeListingStatusDeps,
  { listingId, status }: { listingId: string; status: ListingStatus },
): Promise<Listing> {
  const listing = await deps.listings.get(listingId);
  if (listing === null) {
    throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${listingId}`, {
      details: { listingId },
    });
  }
  if (!canChangeListingStatus(listing.status, status)) {
    throw invalid(listing, status, `No se puede pasar de ${listing.status} a ${status}`);
  }
  if (status === "ready") {
    const media = await deps.media.listOriginals(listing.id);
    if (!media.some((item) => item.kind === "image")) {
      throw invalid(listing, status, "Para pasar a ready hace falta al menos una foto");
    }
  }
  if (!(await deps.listings.changeStatus(listing.id, listing.status, status))) {
    throw invalid(
      listing,
      status,
      "El estado del aviso cambió mientras tanto: vuelve a intentarlo",
    );
  }
  const updated = await deps.listings.get(listing.id);
  if (updated === null) {
    throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${listingId}`, {
      details: { listingId },
    });
  }
  return updated;
}
