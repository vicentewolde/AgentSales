import {
  type DailyReadinessResponse,
  dailyReadinessResponseSchema,
  type PostWeekApproveResponse,
  postWeekApproveResponseSchema,
  postWeekResponseSchema,
  type ReadinessItemView,
} from "@agentsales/api/contracts";
import {
  formatChileTime,
  LANGUAGE_TEXT,
  PLATFORM_TEXT,
  planWeekText,
  publicationModeText,
  WEEK_PROBLEM_TEXT,
} from "@agentsales/core";
import { unwrap } from "../api-client.js";
import type { Colors } from "../colors.js";
import { type CliContext, exitWith, type Terminal } from "../context.js";
import { CliError, guarded } from "../output.js";
import { type BrandDeps, brandOf } from "./brand.js";
import { confirmLive } from "./schedule.js";

// F9.5-T27: publicar a diario desde una marca. `agentsales post approve-week` aprueba y programa de
// una vez las ideas aceptadas de una semana, cada una a su fecha; `agentsales brand ready` muestra
// la lista «Lista para publicar a diario» con qué falta y cómo resolverlo. Nada publica en el
// momento ni cambia el modo, las cuentas o las pruebas de entrada.

export type ApproveWeekDeps = Omit<BrandDeps, "cwd"> & Pick<Terminal, "confirm">;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `--start AAAA-MM-DD`: un día de la semana (hora de Chile); que exista lo revisa la API. */
function startOption(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const day = text.trim();
  if (!DAY.test(day)) {
    throw new CliError(
      "WEEK_INVALID",
      `--start debe ser un día "AAAA-MM-DD" de la semana (hora de Chile): "${text}"`,
    );
  }
  return day;
}

/** Lo que dejó «Aprobar la semana», post por post. */
export function renderWeekResult(result: PostWeekApproveResponse, c: Colors): string[] {
  const lines: string[] = [];
  const mode = publicationModeText(result.dryRun);
  for (const post of result.posts) {
    lines.push(`${formatChileTime(post.plannedAt)}  ${c.bold(post.topic)}`);
    for (const row of post.scheduled) {
      lines.push(
        `  ${c.green("✓")} ${PLATFORM_TEXT[row.platform]}: programado para ${formatChileTime(row.at)} (${mode})`,
      );
    }
    for (const problem of post.problems) {
      const where =
        problem.platform === null
          ? "El post"
          : `${PLATFORM_TEXT[problem.platform]}${problem.language === null ? "" : ` · ${LANGUAGE_TEXT[problem.language]}`}`;
      const { text, hint } = WEEK_PROBLEM_TEXT[problem.kind];
      lines.push(`  ${c.yellow("–")} ${where}: ${text} (${problem.code}: ${problem.message})`);
      if (hint !== "") lines.push(c.dim(`      → ${hint}`));
    }
  }
  return lines;
}

export type PostApproveWeekOptions = {
  broker?: string;
  start?: string;
  yes?: boolean;
  json?: boolean;
};

/**
 * `agentsales post approve-week [--broker <slug>] [--start AAAA-MM-DD] [--yes] [--json]`: muestra
 * los posts aceptados de la semana (sin `--start`, la de mañana), pide confirmación si la marca
 * está en vivo (como programar) y los aprueba y programa cada uno a su fecha. Nunca publica en el
 * momento. Sale con 1 si algo no se pudo.
 */
export function runPostApproveWeek(deps: ApproveWeekDeps, options: PostApproveWeekOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const day = startOption(options.start);
    const broker = await brandOf(deps.client, options.broker);
    const week = await unwrap(
      deps.client.brokers[":id"].week.$get({
        param: { id: broker.id },
        query: day === undefined ? {} : { day },
      }),
      postWeekResponseSchema,
    );
    if (!options.json) {
      deps.print(`${c.bold(broker.brandName)} · ${planWeekText(week.week)} (hora de Chile)`);
    }
    if (week.posts.length === 0) {
      deps.print(
        week.ideas > 0
          ? `No hay ideas aceptadas esa semana: ${week.ideas} siguen sin decidir (agentsales plan show <plan>).`
          : "No hay ideas aceptadas esa semana: pide un plan (agentsales plan) y acepta las que quieras.",
      );
      return 0;
    }
    if (!options.json) {
      for (const item of week.posts) {
        const texts = item.contents
          .map((content) => `${PLATFORM_TEXT[content.platform]} (${content.language})`)
          .join(", ");
        const when =
          item.post.plannedAt === null ? "sin fecha" : formatChileTime(item.post.plannedAt);
        deps.print(`  ${when}  ${item.post.topic}: ${texts === "" ? "sin textos" : texts}`);
      }
    }
    const live = await confirmLive(deps, options.yes ?? false);
    if (live === null) return 1;
    const result = await unwrap(
      deps.client.brokers[":id"].week.approve.$post({
        param: { id: broker.id },
        json: day === undefined ? {} : { day },
      }),
      postWeekApproveResponseSchema,
    );
    const problems = result.posts.reduce((total, post) => total + post.problems.length, 0);
    if (options.json) {
      deps.print(JSON.stringify(result, null, 2));
      return problems > 0 ? 1 : 0;
    }
    deps.print("");
    for (const line of renderWeekResult(result, c)) deps.print(line);
    if (result.ideas > 0) {
      deps.print(c.dim(`${result.ideas} idea(s) de la semana siguen sin decidir: no entraron.`));
    }
    if (!result.dryRun) deps.print(c.red("Programado EN VIVO: a la hora se publica de verdad"));
    deps.print(c.dim("→ Míralo en agentsales agenda; LinkedIn a mano lo publicas tú a su hora"));
    return problems > 0 ? 1 : 0;
  });
}

const STATE_MARK = (c: Colors): Readonly<Record<ReadinessItemView["state"], string>> => ({
  ok: c.green("✓"),
  missing: c.red("✗"),
  operator: c.yellow("?"),
  info: c.dim("·"),
});

function renderItems(items: readonly ReadinessItemView[], c: Colors): string[] {
  const lines: string[] = [];
  for (const item of items) {
    lines.push(`  ${STATE_MARK(c)[item.state]} ${item.label}: ${item.detail}`);
    if (item.fix !== null) {
      lines.push(`      → ${item.fix.text}`);
      if (item.fix.command !== undefined) lines.push(c.dim(`        ${item.fix.command}`));
    }
  }
  return lines;
}

/** La lista «Lista para publicar a diario», legible. */
export function renderReadiness(
  { readiness }: DailyReadinessResponse,
  brandName: string,
  c: Colors,
): string[] {
  const head = readiness.ready
    ? c.green("lista para publicar a diario")
    : c.yellow(
        `${readiness.pending} pendiente${readiness.pending === 1 ? "" : "s"} para publicar a diario`,
      );
  const lines = [`${c.bold(brandName)} (${readiness.slug}): ${head}`, "", "La marca"];
  lines.push(...renderItems(readiness.brand, c));
  for (const network of readiness.networks) {
    lines.push("", `${PLATFORM_TEXT[network.platform]}${network.ready ? ` ${c.green("✓")}` : ""}`);
    lines.push(...renderItems(network.items, c));
  }
  lines.push(
    "",
    c.dim(
      "✓ listo · ✗ falta · ? lo marca el operador · · para saber. Nada de esto se cambia solo.",
    ),
  );
  return lines;
}

export type BrandReadyOptions = { broker?: string; json?: boolean };

/**
 * `agentsales brand ready [--broker <slug>] [--json]`: la lista «Lista para publicar a diario» de
 * la marca (cuenta, prueba de entrada, modo, worker con horario y topes), con qué falta y cómo.
 * Solo lee.
 */
export function runBrandReady(deps: Omit<BrandDeps, "cwd">, options: BrandReadyOptions = {}) {
  return guarded(deps, async () => {
    const broker = await brandOf(deps.client, options.broker);
    const response = await unwrap(
      deps.client.brokers[":id"]["daily-readiness"].$get({ param: { id: broker.id } }),
      dailyReadinessResponseSchema,
    );
    if (options.json) deps.print(JSON.stringify(response.readiness, null, 2));
    else
      for (const line of renderReadiness(response, broker.brandName, deps.colors)) deps.print(line);
    return 0;
  });
}

/** Lo que `post` y `brand` registran de esta tarea. */
export const brandWeekCommands = {
  approveWeek: (ctx: CliContext) => (options: PostApproveWeekOptions) =>
    exitWith(() => runPostApproveWeek({ ...ctx, client: ctx.api() }, options)),
  ready: (ctx: CliContext) => (options: BrandReadyOptions) =>
    exitWith(() => runBrandReady({ ...ctx, client: ctx.api() }, options)),
};
