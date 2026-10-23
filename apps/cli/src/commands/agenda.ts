import { type AgendaResponse, agendaResponseSchema } from "@agentsales/api/contracts";
import {
  AGENDA_KIND_TEXT,
  AGENDA_KINDS,
  formatChileTime,
  nextWorkerCheckText,
  PLATFORM_TEXT,
  publicationFormatText,
} from "@agentsales/core";
import type { Command } from "commander";
import { type ApiClient, unwrap } from "../api-client.js";
import type { Colors } from "../colors.js";
import { type CliContext, exitWith } from "../context.js";
import { guarded, type Io } from "../output.js";
import { brokerSlugOf, platformShortName } from "./shared.js";

// F6-T11 (spec F6 §4.9): la agenda en la terminal, con el comando para cada acción. Desde F9-T08,
// con los posts junto a los avisos (el tema como título), lo que no se sabe si salió, lo que está
// listo para publicar a mano y las cuentas por reconectar.

export type AgendaDeps = Io & { client: ApiClient };
export type AgendaOptions = { broker?: string; json?: boolean };

type Item = AgendaResponse["items"][number];

/**
 * Los comandos de una publicación por su id, que valen igual para un aviso o un post: resolver una
 * `outcome_unknown` y confirmar una a mano (`publications resolve`, F9-T12).
 */
function publicationCommands(item: Item): string[] | null {
  const id = item.publicationId;
  switch (item.action) {
    case "resolve":
      return [
        `agentsales publications resolve ${id} --published`,
        `agentsales publications resolve ${id} --not-published`,
      ];
    case "confirm":
      return [
        `pbpaste | agentsales publications confirm ${id} --url-stdin`,
        `agentsales publications not-published ${id}`,
      ];
    default:
      return null;
  }
}

/**
 * Encender el worker (F9.5-T24, ADR-0037): en el servidor lo enciende el horario en su revisión de cada hora; para
 * que salga ya, el workflow a mano. En el Mac, `pnpm dev`.
 */
export const START_WORKER_COMMANDS = [
  "en el servidor: GitHub → Actions → «Encender el worker» → Run workflow (docs/10-despliegue.md, paso 8)",
  "en el Mac: pnpm dev",
] as const;

/**
 * Los comandos de un post (F9-T08): verlo (`agentsales post show`, con sus textos y publicaciones)
 * y lo que se hace por el id de la publicación: resolver, confirmar, publicar ya o reintentar
 * (`publications retry`, F9-T12), reprogramar o desprogramar.
 */
function postCommands(item: Item, postId: string): string[] {
  const show = `agentsales post show ${postId}`;
  const byId = publicationCommands(item);
  if (byId !== null) return [show, ...byId];
  if (item.action === "start_worker" || item.action === "wait_worker") {
    return [show, ...START_WORKER_COMMANDS];
  }
  const retry = `agentsales publications retry ${item.publicationId}`;
  if (item.kind === "overdue") {
    return [
      show,
      retry,
      `agentsales schedule --publication ${item.publicationId} --at "AAAA-MM-DD HH:MM"`,
    ];
  }
  if (item.kind === "upcoming") return [show, `agentsales unschedule ${item.publicationId}`];
  if (item.action === "publish" || item.action === "retry" || item.action === "requeue") {
    return [show, retry];
  }
  return [show];
}

/** Los comandos que resuelven un ítem (la acción sugerida de la agenda). */
export function agendaCommands(item: Item): string[] {
  if (item.postId !== null) return postCommands(item, item.postId);
  const byId = publicationCommands(item);
  if (byId !== null) return byId;
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
    case "reconnect":
      // LinkedIn no renueva su token: se vuelve a conectar (`accounts connect linkedin`, F9-T19).
      return [
        `agentsales accounts connect ${item.platform === null ? "<plataforma>" : platformShortName(item.platform)} --broker ${item.brokerSlug ?? "<slug>"}`,
      ];
    case "start_worker":
    case "wait_worker":
      return [...START_WORKER_COMMANDS];
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
      : `${PLATFORM_TEXT[item.platform] ?? item.platform}${item.format === null ? "" : ` ${publicationFormatText(item.platform, item.format, item.mediaCount)}`}`;
  const when =
    item.at === null
      ? null
      : item.kind === "expiring" || item.kind === "token_expiring"
        ? item.expired
          ? `venció (${formatChileTime(item.at)})`
          : `vence en ${item.daysLeft} ${item.daysLeft === 1 ? "día" : "días"} (${formatChileTime(item.at)})`
        : formatChileTime(item.at);
  // D4 del spec F9.5: el modo solo si ya está fijado (una aprobada usa el del servidor al publicar).
  const mode =
    item.dryRun === null || !item.modeFixed ? null : item.dryRun ? "simulación" : c.red("en vivo");
  // El título: el `id_propiedad`, el tema del post (marcado como post) o el nombre de la cuenta.
  const title = `${c.bold(item.title ?? item.externalRef ?? "—")}${item.postId === null ? "" : c.dim(" (post)")}`;
  const parts = [title, channel, when, mode].filter(Boolean);
  const error =
    (item.kind === "failed" || item.kind === "outcome_unknown") && item.code !== null
      ? `\n    ${item.code}: ${item.advice ?? ""}`
      : "";
  return `  ${parts.join(" · ")}${error}`;
}

export function renderAgenda(items: readonly Item[], c: Colors, now: Date = new Date()): string {
  if (items.length === 0) return c.green("Nada pendiente");
  const lines = [c.bold("Agenda")];
  for (const kind of AGENDA_KINDS) {
    const group = items.filter((item) => item.kind === kind);
    if (group.length === 0) continue;
    // El worker apagado (F9.5-T24): lo que espera sale en la próxima revisión del horario.
    const title = `${AGENDA_KIND_TEXT[kind] ?? kind} (${group.length})`;
    lines.push(
      "",
      kind === "worker_off"
        ? `${c.yellow(c.bold(title))} · ${
            // Con horario (`wait_worker`), la revisión lo enciende; sin horario, no se enciende solo.
            group.every((item) => item.action === "wait_worker")
              ? `sale cuando se encienda, en la próxima revisión: ${nextWorkerCheckText(now)}`
              : "sin horario: el worker debe estar encendido"
          }`
        : c.bold(title),
    );
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
      "Lo pendiente de propiedades y posts: el worker apagado con algo por vencer, atrasadas, recordatorios de Marketplace, lo que no se sabe si salió, atascadas, fallas, tareas a mano, lo que espera tu revisión o quedó aprobado sin publicar, cuentas por reconectar, Portal por vencer, próximas y el respaldo",
    )
    .option("--broker <slug>", "solo lo de un corredor o marca")
    .option("--json", "salida en JSON")
    .action((options: AgendaOptions) =>
      exitWith(() => runAgenda({ ...ctx, client: ctx.api() }, options)),
    );
}
