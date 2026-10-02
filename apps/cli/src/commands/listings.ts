import { brokerListResponseSchema, listingListResponseSchema } from "@agentsales/api/contracts";
import {
  type Broker,
  formatPrice,
  LISTING_STATUSES,
  type ListingStatus,
  type Operation,
} from "@agentsales/core";
import { type Command, Option } from "commander";
import { type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith } from "../context.js";
import { guarded, type Io, renderTable } from "../output.js";

export const OPERATION_TEXT: Readonly<Record<Operation, string>> = {
  sale: "Venta",
  rent: "Arriendo",
};

export type ListingsDeps = Io & { client: ApiClient };

export type ListingsOptions = { status?: ListingStatus; json?: boolean };

/** Slug de cada corredor por id, para mostrar de quién es cada aviso. */
export async function fetchBrokers(client: ApiClient): Promise<Map<string, Broker>> {
  const { brokers } = await unwrap(client.brokers.$get(), brokerListResponseSchema);
  return new Map(brokers.map((broker) => [broker.id, broker]));
}

/** `agentsales listings [--status ready] [--json]`: las propiedades, de la más reciente a la más antigua. */
export function runListings(deps: ListingsDeps, options: ListingsOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const { listings } = await unwrap(
      deps.client.listings.$get({
        query: options.status === undefined ? {} : { status: options.status },
      }),
      listingListResponseSchema,
    );
    if (options.json) {
      deps.print(JSON.stringify(listings, null, 2));
      return 0;
    }
    if (listings.length === 0) {
      deps.print(
        options.status === undefined
          ? "Todavía no hay propiedades."
          : `No hay propiedades en estado ${options.status}.`,
      );
      return 0;
    }
    const brokers = await fetchBrokers(deps.client);
    deps.print(
      renderTable(
        ["Propiedad", "Corredor", "Tipo", "Operación", "Comuna", "Precio", "Estado", "Portada"],
        listings.map((listing) => [
          listing.externalRef,
          brokers.get(listing.brokerId)?.slug ?? "—",
          listing.propertyType ?? "—",
          listing.operation === null ? "—" : OPERATION_TEXT[listing.operation],
          listing.comuna ?? "—",
          formatPrice(listing.priceAmount, listing.priceCurrency),
          listing.status,
          listing.coverUrl === null ? c.yellow("no") : "sí",
        ]),
        c,
      ),
    );
    deps.print(
      c.dim(`${listings.length} propiedad(es) · el detalle: agentsales listing <propiedad>`),
    );
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("listings")
    .description("Lista las propiedades cargadas")
    .addOption(new Option("--status <estado>", "solo las de ese estado").choices(LISTING_STATUSES))
    .option("--json", "salida en JSON")
    .action((options: ListingsOptions) =>
      exitWith(() => runListings({ ...ctx, client: ctx.api() }, options)),
    );
}
