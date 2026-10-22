import { AppError } from "../errors.js";
import type { Listing } from "../listing.js";
import { checkMusicTrackId } from "../music/catalog.js";
import type { ListingRepository } from "../ports/listing-repository.js";

/**
 * Elige la música del reel de una propiedad (F9.5-T19): un id del catálogo o `null`, sin música.
 * Un id que no está en el catálogo es `MUSIC_TRACK_INVALID` (400); una propiedad que no existe,
 * `LISTING_NOT_FOUND`. No rehace el reel: lo hace la siguiente preparación («Rehacer imágenes» o
 * `prepare --no-texts`), que ve la clave nueva. El alcance lo revisa la ruta (`ownedBy`).
 */
export async function setListingMusic(
  deps: { listings: Pick<ListingRepository, "setMusicTrack"> },
  { listingId, musicTrackId }: { listingId: string; musicTrackId: string | null },
): Promise<Listing> {
  const listing = await deps.listings.setMusicTrack(listingId, checkMusicTrackId(musicTrackId));
  if (listing === null) {
    throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${listingId}`, {
      details: { listingId },
    });
  }
  return listing;
}
