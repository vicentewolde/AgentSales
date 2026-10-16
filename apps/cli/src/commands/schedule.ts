import { publicationResponseSchema, scheduleResponseSchema } from "@agentsales/api/contracts";
import { PLATFORM_TEXT, type Platform, publicationModeText } from "@agentsales/core";
import type { Command } from "commander";
import { type ApiClient, createHealthFetcher, unwrap } from "../api-client.js";
import { formatChileTime, parseChileTime } from "../chile-time.js";
import { type CliContext, exitWith, type Terminal } from "../context.js";
import { CliError, guarded, type Io } from "../output.js";
import { publicationName } from "./publication-view.js";
import { fetchBrokers, platformOption, resolveListingId } from "./shared.js";

// F6-T11 (spec F6 §4.3): programar, reprogramar y desprogramar desde la CLI, en hora de Chile.

export type ScheduleDeps = Io & Pick<Terminal, "confirm"> & { client: ApiClient };

export type ScheduleOptions = {
  at?: string;
  platform?: string[];
  spacing?: string;
  publication?: string;
  broker?: string;
  yes?: boolean;
};

/** `--platform instagram,portal` o repetido: la lista de canales. */
const collect = (value: string, previous: string[] = []) => [
  ...previous,
  ...value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== ""),
];

function spacingOf(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const minutes = Number(text);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 240) {
    throw new CliError(
      "SPACING_INVALID",
      `--spacing debe ser un número de minutos entre 0 y 240: "${text}"`,
    );
  }
  return minutes;
}

/** En vivo, programar pide la misma confirmación que publicar (spec F6 §4.3). */
async function confirmLive(deps: ScheduleDeps, yes: boolean): Promise<boolean | null> {
  const { publishMode } = await createHealthFetcher(deps.client)();
  if (publishMode !== "live" || yes) return publishMode === "live";
  const confirmed = await deps.confirm(
    "La API está EN VIVO: a la hora se publica de verdad, sin volver a preguntar. ¿Programar?",
  );
  if (!confirmed) {
    deps.printError(deps.colors.yellow("No se programó nada: confirma en la terminal o usa --yes"));
    return null;
  }
  return true;
}

/**
 * `agentsales schedule <propiedad…> --at "AAAA-MM-DD HH:MM" [--platform …] [--spacing <min>]`:
 * programa cada canal con texto aprobado de cada propiedad (o solo los de `--platform`), la
 * propiedad i a `at + i × spacing`. `schedule --publication <id> --at …` programa o reprograma una
 * publicación. La hora es de Chile. Sale con 1 si alguna no se pudo programar.
 */
export function runSchedule(deps: ScheduleDeps, refs: readonly string[], options: ScheduleOptions) {
  const c = deps.colors;
  return guarded(deps, async () => {
    if (options.at === undefined) {
      throw new CliError("SCHEDULE_AT_REQUIRED", 'Falta --at "AAAA-MM-DD HH:MM" (hora de Chile)');
    }
    const at = parseChileTime(options.at);
    if (options.publication !== undefined && refs.length > 0) {
      throw new CliError(
        "SCHEDULE_TARGET_INVALID",
        "Usa propiedades o --publication <id>, no las dos cosas",
      );
    }
    if (options.publication === undefined && refs.length === 0) {
      throw new CliError(
        "SCHEDULE_TARGET_INVALID",
        "Di qué programar: una o más propiedades, o --publication <id>",
      );
    }
    const platforms = options.platform?.map(platformOption);
    const spacingMinutes = spacingOf(options.spacing);
    const live = await confirmLive(deps, options.yes ?? false);
    if (live === null) return 1;

    if (options.publication !== undefined) {
      const { publication } = await unwrap(
        deps.client.publications[":id"].schedule.$post({
          param: { id: options.publication.trim() },
          json: { at: at.toISOString() },
        }),
        publicationResponseSchema,
      );
      deps.print(
        `${c.green("✓")} ${publicationName(publication)} programada para ${formatChileTime(publication.scheduledAt ?? at)} (${publicationModeText(publication.dryRun)})`,
      );
      return 0;
    }

    const brokers = await fetchBrokers(deps.client);
    const refOf = new Map<string, string>();
    const listingIds: string[] = [];
    for (const ref of refs) {
      const id = await resolveListingId(deps.client, ref.trim(), brokers, options.broker);
      refOf.set(id, ref.trim());
      listingIds.push(id);
    }
    const { results, notes } = await unwrap(
      deps.client.schedule.$post({
        json: {
          listingIds,
          at: at.toISOString(),
          ...(platforms === undefined ? {} : { platforms: [...new Set(platforms)] }),
          ...(spacingMinutes === undefined ? {} : { spacingMinutes }),
        },
      }),
      scheduleResponseSchema,
    );
    for (const row of results) {
      const name = `${refOf.get(row.listingId) ?? row.listingId}${row.platform === null ? "" : ` ${PLATFORM_TEXT[row.platform as Platform]}`}`;
      if (row.outcome === "scheduled") {
        const mode =
          row.publications?.[0] === undefined
            ? ""
            : ` (${publicationModeText(row.publications[0].dryRun)})`;
        deps.print(
          `${c.green("✓")} ${name}: programada para ${formatChileTime(row.at ?? at)}${mode}`,
        );
      } else {
        deps.print(`${c.yellow("–")} ${name}: no se programó (${row.code}: ${row.message})`);
      }
    }
    for (const note of notes) deps.print(c.yellow(note));
    if (live) deps.print(c.red("Programada EN VIVO: a la hora se publica de verdad"));
    return results.some((row) => row.outcome === "skipped") ? 1 : 0;
  });
}

/** `agentsales unschedule <id>`: desprograma una publicación (vuelve a aprobada). */
export function runUnschedule(deps: ScheduleDeps, id: string) {
  return guarded(deps, async () => {
    const { publication } = await unwrap(
      deps.client.publications[":id"].unschedule.$post({ param: { id: id.trim() } }),
      publicationResponseSchema,
    );
    deps.print(
      `${deps.colors.green("✓")} ${publicationName(publication)} desprogramada: queda aprobada`,
    );
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  const deps = (): ScheduleDeps => ({ ...ctx, client: ctx.api() });
  program
    .command("schedule")
    .description(
      'Programa propiedades a una hora de Chile (--at "2026-10-19 10:00"), o una publicación con --publication',
    )
    .argument("[propiedades...]", "id_propiedad del Excel, o el id del aviso")
    .option("--at <hora>", 'hora de Chile: "AAAA-MM-DD HH:MM"')
    .option(
      "--platform <canal>",
      "instagram, portal o marketplace (repetible o separado por comas)",
      collect,
    )
    .option("--spacing <minutos>", "minutos entre una propiedad y la siguiente (0 a 240)")
    .option("--publication <id>", "programa o reprograma una publicación")
    .option("--broker <slug>", "corredor, si el id_propiedad está en más de uno")
    .option("--yes", "no pide confirmación en vivo")
    .action((refs: string[], options: ScheduleOptions) =>
      exitWith(() => runSchedule(deps(), refs, options)),
    );
  program
    .command("unschedule")
    .description("Desprograma una publicación (queda aprobada)")
    .argument("<id>", "id de la publicación (agentsales publications <propiedad>)")
    .action((id: string) => exitWith(() => runUnschedule(deps(), id)));
}
