import { type TrackingResponse, trackingResponseSchema } from "@agentsales/api/contracts";
import {
  CLOSE_REASON_TEXT,
  LISTING_STATUS_TEXT,
  PLATFORMS,
  PUBLICATION_STATUS_TEXT,
  publicationFormatText,
} from "@agentsales/core";
import type { Command } from "commander";
import { type ApiClient, unwrap } from "../api-client.js";
import type { Colors } from "../colors.js";
import { type CliContext, exitWith } from "../context.js";
import { guarded, type Io, renderTable } from "../output.js";
import { brokerSlugOf } from "./shared.js";

// F6-T11 (spec F6 §4.9): la matriz de seguimiento en una tabla compacta.

export type TrackingDeps = Io & { client: ApiClient };
export type TrackingOptions = { broker?: string; archived?: boolean; json?: boolean };

type Row = TrackingResponse["rows"][number];
type Cell = Row["cells"][keyof Row["cells"]][number];

function cellText(platform: (typeof PLATFORMS)[number], publication: Cell, c: Colors): string {
  const notes = [
    publication.schedule === "overdue" ? c.yellow("atrasada") : null,
    publication.manualTask ? c.yellow("a mano") : null,
    publication.expiry?.soon ? c.yellow(`vence en ${publication.expiry.daysLeft} d`) : null,
    publication.error === null ? null : c.red(publication.error.code),
    publication.dryRun ? null : c.red("vivo"),
  ].filter(Boolean);
  return `${publicationFormatText(platform, publication.format)} ${PUBLICATION_STATUS_TEXT[publication.status]}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`;
}

export function renderTracking(rows: readonly Row[], c: Colors): string {
  if (rows.length === 0) return "Sin propiedades";
  return renderTable(
    ["Propiedad", "Estado", "Instagram", "Portal", "Marketplace"],
    rows.map((row) => [
      row.listing.externalRef,
      `${LISTING_STATUS_TEXT[row.listing.status]}${row.listing.closeReason === null ? "" : ` (${CLOSE_REASON_TEXT[row.listing.closeReason]})`}`,
      ...PLATFORMS.map((platform) => {
        const cell = row.cells[platform];
        return cell.length === 0
          ? c.dim("—")
          : cell.map((p) => cellText(platform, p, c)).join(", ");
      }),
    ]),
    c,
  );
}

/** `agentsales tracking [--broker <slug>] [--archived] [--json]`. */
export function runTracking(deps: TrackingDeps, options: TrackingOptions = {}) {
  return guarded(deps, async () => {
    const query = {
      ...(options.broker === undefined ? {} : { broker: brokerSlugOf(options.broker) }),
      ...(options.archived ? { archived: "1" as const } : {}),
    };
    const { rows } = await unwrap(deps.client.tracking.$get({ query }), trackingResponseSchema);
    deps.print(
      options.json ? JSON.stringify({ rows }, null, 2) : renderTracking(rows, deps.colors),
    );
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("tracking")
    .description("Seguimiento: cada propiedad con su estado en Instagram, Portal y Marketplace")
    .option("--broker <slug>", "solo las propiedades de un corredor")
    .option("--archived", "incluye las archivadas")
    .option("--json", "salida en JSON")
    .action((options: TrackingOptions) =>
      exitWith(() => runTracking({ ...ctx, client: ctx.api() }, options)),
    );
}
