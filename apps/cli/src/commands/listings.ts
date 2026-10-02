import { listingListResponseSchema } from "@agentsales/api/contracts";
import { formatListingPrice, LISTING_STATUSES, type ListingStatus } from "@agentsales/core";
import { type Command, Option } from "commander";
import { type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith } from "../context.js";
import { guarded, type Io, renderTable } from "../output.js";
import { fetchBrokers, OPERATION_TEXT } from "./shared.js";

export type ListingsDeps = Io & { client: ApiClient };

export type ListingsOptions = { status?: ListingStatus; json?: boolean };

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
          formatListingPrice(listing),
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
