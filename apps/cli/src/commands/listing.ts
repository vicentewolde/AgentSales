import { type ListingDetailResponse, listingDetailResponseSchema } from "@agentsales/api/contracts";
import {
  type Broker,
  describeAttributes,
  formatListingPrice,
  LISTING_STATUS_TEXT,
  OPERATION_TEXT,
} from "@agentsales/core";
import type { Command } from "commander";
import { type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith } from "../context.js";
import { formatBytes, guarded, type Io } from "../output.js";
import { fetchBrokers, resolveListingId } from "./shared.js";

export type ListingDeps = Io & { client: ApiClient };

export type ListingOptions = { broker?: string; json?: boolean };

export function renderListingDetail(
  { listing, media, fields }: ListingDetailResponse,
  brokers: Map<string, Broker>,
  c: Io["colors"],
): string {
  const title = [
    listing.externalRef,
    [
      listing.propertyType ?? "Propiedad",
      listing.operation === null ? null : `en ${OPERATION_TEXT[listing.operation].toLowerCase()}`,
    ]
      .filter(Boolean)
      .join(" "),
    listing.comuna,
  ]
    .filter(Boolean)
    .join(" · ");
  const address = [listing.address, listing.unitNumber, listing.comuna, listing.region]
    .filter(Boolean)
    .join(", ");
  const lines = [
    c.bold(title),
    `  Estado: ${LISTING_STATUS_TEXT[listing.status]} (${listing.status}) · Corredor: ${brokers.get(listing.brokerId)?.slug ?? "—"}`,
    `  Precio: ${formatListingPrice(listing)}`,
    `  Dirección: ${address || "—"}${
      listing.showExactAddress ? "" : c.dim(" (no se publica la dirección exacta)")
    }`,
  ];
  if (listing.highlights) lines.push(`  Destacados: ${listing.highlights}`);
  if (listing.internalNotes) {
    lines.push(`  Notas internas ${c.dim("(no se publican)")}: ${listing.internalNotes}`);
  }
  lines.push(`  id: ${listing.id}`);

  const attributes = describeAttributes(listing.attributes, fields).map(
    ({ label, value, extra }) => `  ${label}${extra ? " (columna extra)" : ""}: ${value}`,
  );
  if (attributes.length > 0) lines.push("", c.bold("Atributos"), ...attributes);

  lines.push("", c.bold(`Medios (${media.length})`));
  if (media.length === 0) {
    lines.push(`  ${c.yellow("Sin fotos ni videos")}`);
  }
  for (const [index, item] of media.entries()) {
    const kind = item.kind === "image" ? "foto " : "video";
    const cover = item.isCover ? `  ${c.green("portada")}` : "";
    lines.push(`  ${index + 1}. ${kind}  ${item.mime}  ${formatBytes(item.bytes)}${cover}`);
  }
  return lines.join("\n");
}

/** `agentsales listing <id_propiedad|id> [--broker <slug>] [--json]`: el detalle de un aviso. */
export function runListing(deps: ListingDeps, ref: string, options: ListingOptions = {}) {
  return guarded(deps, async () => {
    const brokers = await fetchBrokers(deps.client);
    // Copiado de una tabla o de un mensaje, el código puede traer espacios alrededor.
    const id = await resolveListingId(deps.client, ref.trim(), brokers, options.broker);
    const detail = await unwrap(
      deps.client.listings[":id"].$get({ param: { id } }),
      listingDetailResponseSchema,
    );
    deps.print(
      options.json
        ? JSON.stringify(detail, null, 2)
        : renderListingDetail(detail, brokers, deps.colors),
    );
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("listing")
    .description("Detalle de una propiedad, con sus atributos y medios")
    .argument("<propiedad>", "id_propiedad del Excel, o el id del aviso")
    .option("--broker <slug>", "corredor, si el id_propiedad está en más de uno")
    .option("--json", "salida en JSON (con las URLs temporales de los medios)")
    .action((ref: string, options: ListingOptions) =>
      exitWith(() => runListing({ ...ctx, client: ctx.api() }, ref, options)),
    );
}
