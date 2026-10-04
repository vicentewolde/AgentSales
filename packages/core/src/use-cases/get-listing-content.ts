import {
  type CheckedContent,
  type ContentCheckDeps,
  checked,
  loadCheckContext,
} from "../content/check-context.js";
import { composeCarousel, composePhotoSet, composeReel } from "../content/compose.js";
import type { ContentRun } from "../content.js";
import type { Media } from "../media.js";
import type { ContentRepository, ContentRunRepository } from "../ports/content-repository.js";
import type { MediaRepository } from "../ports/media-repository.js";

export type GetListingContentDeps = ContentCheckDeps & {
  media: Pick<MediaRepository, "listByListing">;
  contents: Pick<ContentRepository, "listCurrent">;
  contentRuns: Pick<ContentRunRepository, "latest">;
};

export type ListingContent = {
  /** El texto vigente de cada canal (en el orden de `PLATFORMS`); vacío si nunca se generó. */
  contents: CheckedContent[];
  /** El carrusel de Instagram: portada, fotos `ig_4x5` y ficha (hasta 10). */
  carousel: Media[];
  /** Las fotos de Portal Inmobiliario y Marketplace (`pi_4x3`, la portada primero). */
  photos: Media[];
  reel: Media | null;
  /** La corrida más reciente, en cualquier estado. */
  latestRun: ContentRun | null;
};

/**
 * El contenido de un aviso para revisar (spec F2 §4.6 y §4.7, `GET /listings/:id/content`): el
 * texto vigente de cada canal con su revisión, los medios compuestos por canal y la última corrida.
 * La revisión usa lo privado del aviso (dirección, unidad y notas) para detectar fugas: quien llama
 * expone solo los `checks`, nunca el contexto. Un aviso que no existe es `LISTING_NOT_FOUND`.
 */
export async function getListingContent(
  deps: GetListingContentDeps,
  { listingId }: { listingId: string },
): Promise<ListingContent> {
  const { listing, ctx } = await loadCheckContext(deps, listingId);
  const [contents, media, latestRun] = await Promise.all([
    deps.contents.listCurrent(listing.id),
    deps.media.listByListing(listing.id),
    deps.contentRuns.latest(listing.id),
  ]);
  return {
    contents: contents.map((content) => checked(content, ctx)),
    carousel: composeCarousel(media),
    photos: composePhotoSet(media),
    reel: composeReel(media),
    latestRun,
  };
}
