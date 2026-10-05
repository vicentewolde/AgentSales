import type { Broker } from "../broker.js";
import type { Content } from "../content.js";
import { AppError } from "../errors.js";
import type { Listing } from "../listing.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { FieldDefinitionRepository } from "../ports/field-definition-repository.js";
import type { ListingRepository } from "../ports/listing-repository.js";
import {
  buildContentCheckContext,
  type ContentCheck,
  type ContentCheckContext,
  checkContent,
} from "./check.js";

/** Lo que hace falta para revisar los textos de un aviso (`checkContent`). */
export type ContentCheckDeps = {
  listings: Pick<ListingRepository, "get">;
  brokers: Pick<BrokerRepository, "findById">;
  fieldDefinitions: Pick<FieldDefinitionRepository, "list">;
};

/** Un texto con su revisión editorial, calculada al leer (no se guarda). */
export type CheckedContent = { content: Content; checks: ContentCheck[] };

const listingNotFound = (listingId: string) =>
  new AppError("LISTING_NOT_FOUND", `No existe el aviso ${listingId}`, { details: { listingId } });

/**
 * El aviso, su corredor y el contexto de su revisión (brief, contacto y lo privado). Lo usan la
 * corrida (`prepareContent`, para la IA, el ensamblado y la revisión) y la lectura y la edición
 * (`getListingContent` y `editContent`) y la evaluación del prompt (`evaluateListingContent`): así la revisión al leer mide contra los mismos datos que
 * la de la corrida. `LISTING_NOT_FOUND` o `BROKER_NOT_FOUND` si falta alguno.
 */
export async function loadCheckContext(
  deps: ContentCheckDeps,
  listingId: string,
): Promise<{ listing: Listing; broker: Broker; ctx: ContentCheckContext }> {
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
  return { listing, broker, ctx: buildContentCheckContext(listing, definitions, broker) };
}

/** Revisa un texto con el contexto del aviso. */
export const checked = (content: Content, ctx: ContentCheckContext): CheckedContent => ({
  content,
  checks: checkContent(content.platform, content, ctx),
});
