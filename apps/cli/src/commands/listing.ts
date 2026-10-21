import {
  type ListingDetailResponse,
  listingDetailResponseSchema,
  listingStatusResponseSchema,
} from "@agentsales/api/contracts";
import {
  type Broker,
  type CloseReason,
  describeAttributes,
  formatListingPrice,
  LISTING_STATUS_TEXT,
  type ListingAction,
  OPERATION_TEXT,
  PUBLICATION_STATUS_TEXT,
} from "@agentsales/core";
import type { Command } from "commander";
import { type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith, type Terminal } from "../context.js";
import { CliError, formatBytes, guarded, type Io } from "../output.js";
import { publicationName } from "./publication-view.js";
import { fetchBrokers, resolveListingId, withConfirmation } from "./shared.js";

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

/** Los motivos de cierre en español (`--reason`), como los dice el operador. */
export const CLOSE_REASON_OPTIONS: Readonly<Record<string, CloseReason>> = {
  vendida: "sold",
  arrendada: "rented",
  retirada: "withdrawn",
};

const ACTION_DONE: Readonly<Record<ListingAction, string>> = {
  ready: "quedó lista",
  pause: "quedó pausada",
  resume: "se reanudó",
  close: "quedó cerrada",
  reopen: "se reabrió",
  archive: "quedó archivada",
};

export type ListingActionDeps = ListingDeps & Pick<Terminal, "confirm">;
export type ListingActionOptions = { broker?: string; reason?: string; yes?: boolean };

/**
 * `agentsales listing ready|pause|resume|reopen|archive <propiedad>` y `listing close <propiedad>
 * --reason vendida|arrendada|retirada` (spec F6 §4.8): la propiedad manda sobre sus publicaciones.
 * Lo que pide confirmación (cerrar; pausar o archivar si cambian algo) se pregunta con el motivo de
 * la API (`--yes` no pregunta). Muestra qué cambió y las tareas a mano, con el comando de cada una.
 */
export function runListingAction(
  deps: ListingActionDeps,
  action: ListingAction,
  ref: string,
  options: ListingActionOptions = {},
) {
  const c = deps.colors;
  return guarded(deps, async () => {
    let reason: CloseReason | undefined;
    if (action === "close") {
      reason =
        options.reason === undefined
          ? undefined
          : CLOSE_REASON_OPTIONS[options.reason.trim().toLowerCase()];
      if (reason === undefined) {
        throw new CliError(
          "CLOSE_REASON_REQUIRED",
          `Di por qué se cierra: --reason ${Object.keys(CLOSE_REASON_OPTIONS).join(", ")}`,
        );
      }
    }
    const brokers = await fetchBrokers(deps.client);
    const id = await resolveListingId(deps.client, ref.trim(), brokers, options.broker);
    const result = await withConfirmation(deps, {
      yes: options.yes ?? false,
      codes: ["LISTING_ACTION_NOT_CONFIRMED"],
      call: (confirmed) =>
        unwrap(
          deps.client.listings[":id"].status.$post({
            param: { id },
            json: {
              action,
              ...(reason === undefined ? {} : { reason }),
              ...(confirmed ? { confirmed } : {}),
            },
          }),
          listingStatusResponseSchema,
        ),
    });
    if (result === null) return 1;
    const { listing, changed, manualTasks } = result;
    deps.print(
      `${c.green("✓")} ${listing.externalRef} ${ACTION_DONE[action]}: ${LISTING_STATUS_TEXT[listing.status]}`,
    );
    for (const publication of changed) {
      deps.print(
        `  ${publicationName(publication)}: ${PUBLICATION_STATUS_TEXT[publication.status]}`,
      );
    }
    if (manualTasks.length > 0) {
      deps.print(c.yellow("Tareas a mano (bórralas en la plataforma y márcalas retiradas):"));
      for (const publication of manualTasks) {
        deps.print(
          `  ${publicationName(publication)}${publication.externalUrl === null ? "" : ` ${publication.externalUrl}`}`,
        );
        deps.print(c.dim(`    agentsales publications retire ${publication.id}`));
      }
    }
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  const listing = program
    .command("listing")
    .description("Detalle de una propiedad, con sus atributos y medios")
    .argument("<propiedad>", "id_propiedad del Excel, o el id del aviso")
    .option("--broker <slug>", "corredor, si el id_propiedad está en más de uno")
    .option("--json", "salida en JSON (con las URLs temporales de los medios)")
    .action((ref: string, options: ListingOptions) =>
      exitWith(() => runListing({ ...ctx, client: ctx.api() }, ref, options)),
    );
  const actions: Array<[ListingAction, string]> = [
    ["ready", "Deja lista una propiedad en borrador (con al menos una foto)"],
    ["pause", "Pausa la propiedad: pausa su aviso de Portal y desprograma lo programado"],
    ["resume", "Reanuda la propiedad y reactiva lo que pausó"],
    ["reopen", "Reabre una propiedad cerrada o archivada (borra el motivo; no publica nada)"],
    ["archive", "Archiva la propiedad (sin publicaciones vivas: ciérrala antes)"],
  ];
  for (const [action, description] of actions) {
    listing
      .command(action)
      .description(description)
      .argument("<propiedad>", "id_propiedad del Excel, o el id del aviso")
      .option("--broker <slug>", "corredor, si el id_propiedad está en más de uno")
      .option("--yes", "no pide confirmación")
      // `listing` también tiene `--broker` y commander se lo entrega al padre: `optsWithGlobals`
      // lo trae desde ahí (como en `plan list`, ensayo de la demo de F9).
      .action((ref: string, _options: ListingActionOptions, command: Command) =>
        exitWith(() =>
          runListingAction(
            { ...ctx, client: ctx.api() },
            action,
            ref,
            command.optsWithGlobals<ListingActionOptions>(),
          ),
        ),
      );
  }
  listing
    .command("close")
    .description(
      "Cierra la propiedad (vendida, arrendada o retirada): cierra Portal y deja Instagram y Marketplace en vivo como tareas a mano",
    )
    .argument("<propiedad>", "id_propiedad del Excel, o el id del aviso")
    // `.option` y no `.requiredOption`: el motivo que falta lo explica la CLI, en español.
    .option("--reason <motivo>", "vendida, arrendada o retirada")
    .option("--broker <slug>", "corredor, si el id_propiedad está en más de uno")
    .option("--yes", "no pide confirmación")
    .action((ref: string, _options: ListingActionOptions, command: Command) =>
      exitWith(() =>
        runListingAction(
          { ...ctx, client: ctx.api() },
          "close",
          ref,
          command.optsWithGlobals<ListingActionOptions>(),
        ),
      ),
    );
}
