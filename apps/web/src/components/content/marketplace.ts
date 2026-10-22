import type { PublicationView } from "@agentsales/api/contracts";
import {
  ACTIVE_PUBLICATION_STATUSES,
  type Currency,
  formatListingPrice,
  marketplacePriceText,
  type Operation,
} from "@agentsales/core";

/** El precio del aviso como está en la planilla (lo que el plan B muestra si nada lo convirtió). */
export type ListingPrice = {
  priceAmount: number;
  priceCurrency: Currency;
  operation: Operation | null;
};

const active = new Set<string>(ACTIVE_PUBLICATION_STATUSES);

type PricedPublication = Pick<PublicationView, "status" | "manual" | "updatedAt">;

/** El precio en pesos del intento más nuevo de una publicación activa que lo convirtió, si hay. */
const convertedPrice = (publications: readonly PricedPublication[]) =>
  publications
    .filter((publication) => active.has(publication.status) && publication.manual !== null)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]?.manual;

/**
 * El precio en la vista previa de Marketplace (F9.5-T07). Convertido por un intento, el mismo
 * texto del plan B y de la CLI (`marketplacePriceText`: en pesos con la UF usada), para que no
 * difieran; si no, el de la planilla y, si está en UF y nada lo convirtió, con el aviso de que se
 * publica en pesos (el panel no consulta la UF). `null` sin precio.
 */
export function marketplacePreviewPrice(
  publications: readonly PricedPublication[],
  listing: ListingPrice | null,
): string | null {
  const converted = convertedPrice(publications);
  if (converted != null) return marketplacePriceText(converted);
  if (listing === null) return null;
  const price = formatListingPrice(listing);
  return listing.priceCurrency === "UF" ? `${price} (se publica en pesos)` : price;
}

/**
 * El precio del plan B de Marketplace (spec F5 §4.12, D13): en pesos con la UF usada si un intento
 * de una publicación **activa** lo convirtió (una descartada o retirada pudo usar un precio viejo);
 * si no, el de la planilla. "Sin convertir" solo si está en UF: el panel no consulta la UF.
 */
export function planBPrice(
  publications: readonly Pick<PublicationView, "status" | "manual" | "updatedAt">[],
  listing: ListingPrice | null,
): string {
  const converted = convertedPrice(publications);
  if (converted != null) return marketplacePriceText(converted);
  if (listing === null) return "—";
  const price = formatListingPrice(listing);
  return listing.priceCurrency === "UF"
    ? `${price} (sin convertir: Marketplace lo pide en pesos)`
    : price;
}
