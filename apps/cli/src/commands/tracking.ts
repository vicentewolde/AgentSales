import { type TrackingResponse, trackingResponseSchema } from "@agentsales/api/contracts";
import {
  CLOSE_REASON_TEXT,
  LISTING_PLATFORMS,
  LISTING_STATUS_TEXT,
  PLATFORM_TEXT,
  type Platform,
  POST_PLATFORMS,
  type PostStatus,
  PUBLICATION_STATUS_TEXT,
  publicationFormatText,
} from "@agentsales/core";
import type { Command } from "commander";
import { type ApiClient, unwrap } from "../api-client.js";
import type { Colors } from "../colors.js";
import { type CliContext, exitWith } from "../context.js";
import { guarded, type Io, renderTable } from "../output.js";
import { brokerSlugOf } from "./shared.js";

// F6-T11 (spec F6 §4.9): la matriz de seguimiento en una tabla compacta. Desde F9-T08 (spec F9
// §4.2), los posts van en el mismo comando, en su propia tabla (sus redes no son las de un aviso),
// con el tema como título.

export type TrackingDeps = Io & { client: ApiClient };
export type TrackingOptions = { broker?: string; archived?: boolean; json?: boolean };

type Row = TrackingResponse["rows"][number];
type PostRow = TrackingResponse["posts"][number];
type Cell = Row["cells"][keyof Row["cells"]][number];

/** El estado de un post (spec F9 §4.2), como lo ve el operador. */
export const POST_STATUS_TEXT: Readonly<Record<PostStatus, string>> = {
  idea: "idea",
  draft: "borrador",
  ready: "listo",
  archived: "archivado",
};

function cellText(platform: Platform, publication: Cell, c: Colors): string {
  const notes = [
    publication.schedule === "overdue" ? c.yellow("atrasada") : null,
    publication.manualTask ? c.yellow("a mano") : null,
    publication.expiry?.soon ? c.yellow(`vence en ${publication.expiry.daysLeft} d`) : null,
    publication.lastError === null ? null : c.red(publication.lastError.code),
    publication.dryRun ? null : c.red("vivo"),
  ].filter(Boolean);
  // Un post con dos idiomas tiene una publicación por idioma: se dice cuál es la inglesa.
  const language = publication.language === "es" ? "" : ` [${publication.language}]`;
  return `${publicationFormatText(platform, publication.format)}${language} ${PUBLICATION_STATUS_TEXT[publication.status] ?? publication.status}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`;
}

export function renderTracking(rows: readonly Row[], c: Colors): string {
  if (rows.length === 0) return "Sin propiedades";
  return renderTable(
    ["Propiedad", "Estado", "Instagram", "Portal", "Marketplace"],
    rows.map((row) => [
      row.listing.externalRef,
      `${LISTING_STATUS_TEXT[row.listing.status] ?? row.listing.status}${row.listing.closeReason === null ? "" : ` (${CLOSE_REASON_TEXT[row.listing.closeReason] ?? row.listing.closeReason})`}`,
      ...LISTING_PLATFORMS.map((platform) => {
        const cell = row.cells[platform];
        return cell.length === 0
          ? c.dim("—")
          : cell.map((p) => cellText(platform, p, c)).join(", ");
      }),
    ]),
    c,
  );
}

/** Los posts (F9-T08): el tema como título, su estado y una columna por red. */
export function renderTrackingPosts(posts: readonly PostRow[], c: Colors): string {
  return renderTable(
    ["Post", "Estado", ...POST_PLATFORMS.map((platform) => PLATFORM_TEXT[platform] ?? platform)],
    posts.map((row) => [
      row.post.topic,
      POST_STATUS_TEXT[row.post.status] ?? row.post.status,
      ...POST_PLATFORMS.map((platform) => {
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
    const { rows, posts } = await unwrap(
      deps.client.tracking.$get({ query }),
      trackingResponseSchema,
    );
    if (options.json) {
      deps.print(JSON.stringify({ rows, posts }, null, 2));
      return 0;
    }
    // Una marca no tiene propiedades: si hay posts y ninguna propiedad, solo los posts.
    const parts = rows.length === 0 && posts.length > 0 ? [] : [renderTracking(rows, deps.colors)];
    if (posts.length > 0) parts.push(renderTrackingPosts(posts, deps.colors));
    deps.print(parts.join("\n\n"));
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("tracking")
    .description(
      "Seguimiento: cada propiedad con su estado en Instagram, Portal y Marketplace, y cada post con el suyo en sus redes",
    )
    .option("--broker <slug>", "solo lo de un corredor o marca")
    .option("--archived", "incluye las archivadas")
    .option("--json", "salida en JSON")
    .action((options: TrackingOptions) =>
      exitWith(() => runTracking({ ...ctx, client: ctx.api() }, options)),
    );
}
