import {
  type ListingDetailResponse,
  listingDetailResponseSchema,
  listingListResponseSchema,
} from "@agentsales/api/contracts";
import { type Broker, formatPrice } from "@agentsales/core";
import type { Command } from "commander";
import { z } from "zod";
import { type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith } from "../context.js";
import { CliError, formatBytes, guarded, type Io } from "../output.js";
import { brokerSlugOf } from "./import.js";
import { fetchBrokers, OPERATION_TEXT } from "./listings.js";

export type ListingDeps = Io & { client: ApiClient };

export type ListingOptions = { broker?: string; json?: boolean };

const isUuid = (text: string) => z.uuid().safeParse(text).success;

/**
 * El id del aviso: un uuid va directo; si no, es el `id_propiedad`, que es único por corredor
 * (spec F1-T12). Si está en más de un corredor, hace falta `--broker`.
 */
async function resolveListingId(
  client: ApiClient,
  ref: string,
  brokers: Map<string, Broker>,
  brokerOption: string | undefined,
): Promise<string> {
  if (isUuid(ref)) return ref;
  const { listings } = await unwrap(
    client.listings.$get({ query: { externalRef: ref } }),
    listingListResponseSchema,
  );
  let matches = listings;
  if (brokerOption !== undefined) {
    const slug = brokerSlugOf(brokerOption);
    const broker = [...brokers.values()].find((candidate) => candidate.slug === slug);
    if (broker === undefined) {
      throw new CliError("BROKER_NOT_FOUND", `No existe el corredor ${slug}`);
    }
    matches = listings.filter((listing) => listing.brokerId === broker.id);
  }
  const [first, ...others] = matches;
  if (first === undefined) {
    throw new CliError(
      "LISTING_NOT_FOUND",
      `No existe la propiedad ${ref.trim()}${brokerOption === undefined ? "" : ` en ese corredor`}`,
      "Revisa el código con agentsales listings",
    );
  }
  if (others.length > 0) {
    const slugs = matches.map((listing) => brokers.get(listing.brokerId)?.slug ?? listing.brokerId);
    throw new CliError(
      "LISTING_AMBIGUOUS",
      `${ref.trim()} existe en ${matches.length} corredores (${slugs.join(", ")})`,
      "Indica cuál con --broker <slug>",
    );
  }
  return first.id;
}

/** Un atributo como texto: listas con coma, `Sí`/`No`, y `_extra` (columnas desconocidas) aplanado. */
function attributeLines(attributes: Record<string, unknown>): string[] {
  const text = (value: unknown): string => {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value === "boolean") return value ? "Sí" : "No";
    if (Array.isArray(value)) return value.map(text).join(", ");
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  };
  return Object.entries(attributes).flatMap(([key, value]) =>
    key === "_extra" && typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.entries(value).map(
          ([column, extra]) => `  ${column} (columna extra): ${text(extra)}`,
        )
      : [`  ${key}: ${text(value)}`],
  );
}

export function renderListingDetail(
  { listing, media }: ListingDetailResponse,
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
    `  Estado: ${listing.status} · Corredor: ${brokers.get(listing.brokerId)?.slug ?? "—"}`,
    `  Precio: ${formatPrice(listing.priceAmount, listing.priceCurrency)}`,
    `  Dirección: ${address || "—"}${
      listing.showExactAddress ? "" : c.dim(" (no se publica la dirección exacta)")
    }`,
  ];
  if (listing.highlights) lines.push(`  Destacados: ${listing.highlights}`);
  if (listing.internalNotes) {
    lines.push(`  Notas internas ${c.dim("(no se publican)")}: ${listing.internalNotes}`);
  }
  lines.push(`  id: ${listing.id}`);

  const attributes = attributeLines(listing.attributes);
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
    const id = await resolveListingId(deps.client, ref, brokers, options.broker);
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
