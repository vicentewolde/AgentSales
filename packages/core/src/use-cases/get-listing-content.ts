import {
  buildContentCheckContext,
  type ContentCheck,
  type ContentCheckContext,
  checkContent,
} from "../content/check.js";
import { composeCarousel, composePhotoSet, composeReel } from "../content/compose.js";
import type { Content, ContentRun } from "../content.js";
import { AppError } from "../errors.js";
import type { Listing } from "../listing.js";
import type { Media } from "../media.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { ContentRepository, ContentRunRepository } from "../ports/content-repository.js";
import type { FieldDefinitionRepository } from "../ports/field-definition-repository.js";
import type { ListingRepository } from "../ports/listing-repository.js";
import type { MediaRepository } from "../ports/media-repository.js";

/** Lo que hace falta para revisar los textos de un aviso (`checkContent`). */
export type ContentCheckDeps = {
  listings: Pick<ListingRepository, "get">;
  brokers: Pick<BrokerRepository, "findById">;
  fieldDefinitions: FieldDefinitionRepository;
};

export type GetListingContentDeps = ContentCheckDeps & {
  media: Pick<MediaRepository, "listByListing">;
  contents: Pick<ContentRepository, "listCurrent">;
  contentRuns: Pick<ContentRunRepository, "latest">;
};

/** Un texto con su revisión editorial, calculada al leer (no se guarda). */
export type CheckedContent = { content: Content; checks: ContentCheck[] };

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

export const listingNotFound = (listingId: string) =>
  new AppError("LISTING_NOT_FOUND", `No existe el aviso ${listingId}`, { details: { listingId } });

/** El aviso y el contexto de su revisión (el mismo que usa la corrida: brief, contacto y lo privado). */
export async function loadCheckContext(
  deps: ContentCheckDeps,
  listingId: string,
): Promise<{ listing: Listing; ctx: ContentCheckContext }> {
  const listing = await deps.listings.get(listingId);
  if (listing === null) throw listingNotFound(listingId);
  const broker = await deps.brokers.findById(listing.brokerId);
  if (broker === null) {
    throw new AppError("BROKER_NOT_FOUND", "No existe el corredor del aviso", {
      details: { listingId },
    });
  }
  const definitions = await deps.fieldDefinitions.list({
    category: listing.category,
    brokerId: listing.brokerId,
  });
  return { listing, ctx: buildContentCheckContext(listing, definitions, broker) };
}

/** Revisa un texto con el contexto del aviso. */
export const checked = (content: Content, ctx: ContentCheckContext): CheckedContent => ({
  content,
  checks: checkContent(content.platform, content, ctx),
});

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
