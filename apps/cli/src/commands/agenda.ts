import { type AgendaResponse, agendaResponseSchema } from "@agentsales/api/contracts";
import {
  AGENDA_KIND_TEXT,
  AGENDA_KINDS,
  formatChileTime,
  PLATFORM_TEXT,
  publicationFormatText,
} from "@agentsales/core";
import type { Command } from "commander";
import { type ApiClient, unwrap } from "../api-client.js";
import type { Colors } from "../colors.js";
import { type CliContext, exitWith } from "../context.js";
import { guarded, type Io } from "../output.js";
import { brokerSlugOf, platformShortName } from "./shared.js";

// F6-T11 (spec F6 §4.9): la agenda en la terminal, con el comando para cada acción.

export type AgendaDeps = Io & { client: ApiClient };
export type AgendaOptions = { broker?: string; json?: boolean };

type Item = AgendaResponse["items"][number];

/** Los comandos que resuelven un ítem (la acción sugerida de la agenda). */
export function agendaCommands(item: Item): string[] {
  // El id del aviso: el `id_propiedad` se puede repetir entre corredores (`resolveListingId`).
  const ref = item.listingId ?? "";
  const channel = item.platform === null ? "" : ` --platform ${platformShortName(item.platform)}`;
  switch (item.action) {
    case "publish":
      return item.kind === "overdue"
        ? [
            `agentsales publish ${ref}${channel}`,
            `agentsales schedule --publication ${item.publicationId} --at "AAAA-MM-DD HH:MM"`,
          ]
        : [`agentsales publish ${ref}${channel}`];
    case "requeue":
    case "retry":
      return [`agentsales publish ${ref}${channel}`];
    case "retire":
      return [`agentsales publications retire ${item.publicationId}`];
    case "review":
      return [
        `agentsales content ${ref}${channel}`,
        `agentsales approve ${ref}${channel}`,
        `agentsales publish ${ref}${channel}`,
      ];
    case "relist":
      return [`agentsales publications relist ${item.publicationId}`];
    case "sync":
      return [`agentsales publications sync ${item.publicationId}`];
    case "backup":
      // En el servidor (F8-T13) el respaldo va a R2 y lo hace el worker: `pnpm db:backup` del Mac
      // no actualiza su estado.
      return [
        "en el Mac: pnpm db:backup",
        "en el servidor: el worker respalda al encenderse y a las 13:00; el error está en sus logs (docs/10-despliegue.md, paso 7)",
      ];
    default:
      return item.kind === "upcoming" ? [`agentsales unschedule ${item.publicationId}`] : [];
  }
}

function itemLine(item: Item, c: Colors): string {
  if (item.kind === "backup") {
    const last = item.at === null ? "nunca" : formatChileTime(item.at);
    const notes = [
      item.stale ? c.yellow("tiene más de 48 h") : null,
      item.code === null ? null : c.yellow(`el último intento falló (${item.code})`),
    ].filter(Boolean);
    return `  Último respaldo: ${last}${notes.length === 0 ? "" : ` · ${notes.join(" · ")}`}`;
  }
  const channel =
    item.platform === null
      ? null
      : `${PLATFORM_TEXT[item.platform]}${item.format === null ? "" : ` ${publicationFormatText(item.platform, item.format)}`}`;
  const when =
    item.at === null
      ? null
      : item.kind === "expiring"
        ? item.expired
          ? `venció (${formatChileTime(item.at)})`
          : `vence en ${item.daysLeft} ${item.daysLeft === 1 ? "día" : "días"} (${formatChileTime(item.at)})`
        : formatChileTime(item.at);
  const mode = item.dryRun === null ? null : item.dryRun ? "simulación" : c.red("en vivo");
  const parts = [c.bold(item.externalRef ?? "—"), channel, when, mode].filter(Boolean);
  const error =
    item.kind === "failed" && item.code !== null ? `\n    ${item.code}: ${item.advice ?? ""}` : "";
  return `  ${parts.join(" · ")}${error}`;
}

export function renderAgenda(items: readonly Item[], c: Colors): string {
  if (items.length === 0) return c.green("Nada pendiente");
  const lines = [c.bold("Agenda")];
  for (const kind of AGENDA_KINDS) {
    const group = items.filter((item) => item.kind === kind);
    if (group.length === 0) continue;
    lines.push("", c.bold(`${AGENDA_KIND_TEXT[kind]} (${group.length})`));
    for (const item of group) {
      lines.push(itemLine(item, c));
      for (const command of agendaCommands(item)) lines.push(c.dim(`    → ${command}`));
    }
  }
  return lines.join("\n");
}

/** `agentsales agenda [--broker <slug>] [--json]`. */
export function runAgenda(deps: AgendaDeps, options: AgendaOptions = {}) {
  return guarded(deps, async () => {
    const query = options.broker === undefined ? {} : { broker: brokerSlugOf(options.broker) };
    const { items } = await unwrap(deps.client.agenda.$get({ query }), agendaResponseSchema);
    deps.print(
      options.json ? JSON.stringify({ items }, null, 2) : renderAgenda(items, deps.colors),
    );
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("agenda")
    .description(
      "Lo pendiente: atrasadas, recordatorios de Marketplace, atascadas, fallas, tareas a mano, lo que espera tu revisión o quedó aprobado sin publicar, Portal por vencer, próximas y el respaldo",
    )
    .option("--broker <slug>", "solo las propiedades de un corredor")
    .option("--json", "salida en JSON")
    .action((options: AgendaOptions) =>
      exitWith(() => runAgenda({ ...ctx, client: ctx.api() }, options)),
    );
}
