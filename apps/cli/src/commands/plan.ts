import {
  type PlanDetailResponse,
  type PlanIdeaView,
  type PlanRunView,
  planDetailResponseSchema,
  planListResponseSchema,
  planRequestResponseSchema,
} from "@agentsales/api/contracts";
import {
  formatChileTime,
  groupByPlanWeek,
  ideaNeedsDraft,
  PLAN_DEFAULT_DAYS,
  PLAN_RUN_STATUS_TEXT,
  PLATFORM_TEXT,
  planWeekText,
} from "@agentsales/core";
import type { Command } from "commander";
import { z } from "zod";
import { ApiCallError, type ApiClient, unwrap } from "../api-client.js";
import type { Colors } from "../colors.js";
import { type CliContext, exitWith } from "../context.js";
import { CliError, guarded, renderTable } from "../output.js";
import { brandOf } from "./brand.js";
import { POST_KIND_TEXT } from "./post.js";
import { collect } from "./schedule.js";
import { fetchBrokers, POST_PLATFORM_OPTION_NAMES, postPlatformOption } from "./shared.js";
import { POST_STATUS_TEXT } from "./tracking.js";
import { type WaitDeps, waitForRun } from "./wait-run.js";

// F9-T21 (spec F9 §4.9 y §4.10, ADR-0030): `agentsales plan`, el plan de ideas de una marca contra la
// API: pedirlo y esperarlo (como `prepare`), verlo con sus ideas por semana y listar los de la marca.
// Aceptar o descartar una idea es `agentsales post accept|discard <id>`.

export type PlanDeps = WaitDeps & { client: ApiClient };

const show = (planId: string) => `agentsales plan show ${planId}`;

/** El id de un plan: un uuid, como lo muestra `agentsales plan list`. */
function planIdOf(id: string): string {
  const trimmed = id.trim();
  if (!z.uuid().safeParse(trimmed).success) {
    throw new CliError(
      "PLAN_ID_INVALID",
      `"${id}" no es el id de un plan`,
      "Mira los planes con agentsales plan list",
    );
  }
  return trimmed;
}

/** Un número entero de una opción (`--days 14`, `--count 6`). */
function integerOption(option: string, text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  if (!/^\d{1,3}$/.test(text.trim())) {
    throw new CliError("OPTION_INVALID", `${option} debe ser un número entero: "${text}"`);
  }
  return Number(text.trim());
}

/** Qué hacer ante los errores del plan: la API manda su código y su mensaje; la CLI suma el comando. */
function planHint(error: ApiCallError): string | undefined {
  const hints: Record<string, string> = {
    PLAN_RUN_NOT_FOUND: "Mira los planes de la marca con agentsales plan list",
    PLAN_RUN_INVALID:
      "Días de 1 a 31, de 1 a 20 ideas, y un inicio entre hoy y 60 días más (--start AAAA-MM-DD)",
    POST_NO_PLATFORMS:
      "Conecta una cuenta de la marca (agentsales accounts) o define la cadencia de una red en su perfil (agentsales brand edit)",
    LLM_BUDGET_EXCEEDED:
      "La marca llegó a su tope de IA del mes: mira el gasto con agentsales usage y pide al administrador subir el tope, o espera al mes siguiente",
    QUEUE_UNAVAILABLE: "Arranca el worker (pnpm dev) y vuelve a pedir el plan",
  };
  return error.code === undefined ? undefined : hints[error.code];
}

/** Un error de la API con su consejo del plan, si lo tiene (los demás siguen su curso). */
function explained(error: unknown): unknown {
  if (!(error instanceof ApiCallError) || error.status === undefined) return error;
  const hint = planHint(error);
  if (hint === undefined) return error;
  return new CliError(error.code ?? "API_ERROR", error.apiMessage ?? error.message, hint);
}

const fetchPlan = (client: ApiClient, planId: string) =>
  unwrap(client.plans[":id"].$get({ param: { id: planId } }), planDetailResponseSchema).catch(
    (error: unknown) => {
      throw explained(error);
    },
  );

/** `del 2026-10-21 al 2026-11-03 · LinkedIn, X`. */
const periodText = (plan: PlanRunView) =>
  `del ${plan.firstDay} al ${plan.lastDay}${
    plan.platforms.length === 0
      ? ""
      : ` · ${plan.platforms.map((platform) => PLATFORM_TEXT[platform]).join(", ")}`
  }`;

/** El estado del plan, con su color. */
function paintStatus(plan: PlanRunView, c: Colors): string {
  const text = PLAN_RUN_STATUS_TEXT[plan.status];
  if (plan.status === "succeeded") return c.green(text);
  if (plan.status === "failed") return c.red(text);
  return c.yellow(text);
}

/** Lo que se hace con una idea según su estado. */
function ideaNextSteps(idea: PlanIdeaView): string[] {
  if (idea.status === "idea") {
    return [
      `Aceptar: agentsales post accept ${idea.id} · descartar: agentsales post discard ${idea.id}`,
    ];
  }
  if (ideaNeedsDraft(idea)) {
    return [`Aceptada sin textos: pídelos con agentsales post draft ${idea.id}`];
  }
  if (idea.status === "draft" && idea.texts === 0) {
    return [
      `La IA está redactando sus textos: míralos cuando terminen con agentsales post show ${idea.id}`,
    ];
  }
  if (idea.status === "draft" || idea.status === "ready") {
    return [`Revisa, aprueba y programa: agentsales post show ${idea.id}`];
  }
  return [];
}

/** Una idea: fecha, tema y estado; su id, línea, redes y tipo; el porqué y lo que sigue. */
function renderIdea(idea: PlanIdeaView, c: Colors): string[] {
  const when = idea.plannedAt === null ? "sin fecha" : formatChileTime(idea.plannedAt);
  const networks =
    idea.platforms === null
      ? "todas las redes de la marca"
      : idea.platforms.map((platform) => PLATFORM_TEXT[platform]).join(", ");
  const status = POST_STATUS_TEXT[idea.status];
  const lines = [
    `  ${c.bold(when)}  ${idea.topic}  ${idea.status === "archived" ? c.dim(`(${status})`) : c.cyan(`[${status}]`)}`,
    c.dim(
      `    ${idea.id} · ${POST_KIND_TEXT[idea.kind]} · ${networks}${idea.pillar === null ? "" : ` · línea ${idea.pillar}`}`,
    ),
  ];
  if (idea.rationale !== null) lines.push(`    Por qué: ${idea.rationale}`);
  for (const note of idea.notes) lines.push(c.dim(`    Sin esa red: ${note}`));
  for (const step of ideaNextSteps(idea)) lines.push(c.dim(`    → ${step}`));
  return lines;
}

/** `plan show`: el plan, su error con qué hacer, las ideas por semana y lo que se descartó. */
export function renderPlanDetail(detail: PlanDetailResponse, brandSlug: string, c: Colors): string {
  const { plan, report, ideas } = detail;
  const lines = [
    `${c.bold(`Plan ${plan.id}`)}  ${paintStatus(plan, c)} · ${brandSlug} · ${periodText(plan)}`,
  ];
  if (plan.error !== null) {
    lines.push(`  ${c.red(`${plan.error.code}: ${plan.error.message}`)}`);
    if (plan.errorAdvice !== null) lines.push(`  ${c.dim(`→ ${plan.errorAdvice}`)}`);
    return lines.join("\n");
  }
  if (plan.status !== "succeeded") {
    lines.push(c.dim(`  Todavía no termina: vuelve a mirarlo con ${show(plan.id)}`));
    return lines.join("\n");
  }
  if (ideas.length === 0) {
    lines.push(c.yellow("  La IA no dejó ideas válidas: mira los descartes y pide otro plan"));
  }
  for (const group of groupByPlanWeek(ideas)) {
    lines.push("", c.bold(group.week === null ? "Sin fecha" : planWeekText(group.week)));
    for (const idea of group.items) lines.push(...renderIdea(idea, c));
  }
  if (report !== null && report.discarded.length > 0) {
    lines.push("", c.bold(`Descartadas por las revisiones (${report.discarded.length})`));
    for (const item of report.discarded) {
      lines.push(c.dim(`  ${item.topic === "" ? "(sin tema)" : item.topic}: ${item.message}`));
    }
  }
  for (const warning of report?.warnings ?? []) lines.push(`  ${c.yellow("⚠")} ${warning}`);
  const footer = [
    "Una idea no se publica sola: al aceptarla la IA redacta sus textos, y después tú los apruebas y programas (agentsales post approve y post schedule).",
  ];
  if (ideas.some((idea) => idea.status === "idea")) {
    footer.push(
      'Antes de aceptar puedes mover la fecha, cambiar las redes o escribir el brief: agentsales post edit <id> --date "AAAA-MM-DD HH:MM" --platforms x,linkedin --brief "…"',
    );
  }
  lines.push("", ...footer.map((line) => c.dim(line)));
  return lines.join("\n");
}

export type PlanRequestOptions = {
  broker?: string;
  days?: string;
  platform?: string[];
  count?: string;
  start?: string;
  wait?: boolean;
};

/**
 * `agentsales plan [--broker] [--days 14] [--platform …] [--count N] [--start AAAA-MM-DD]
 * [--no-wait]`: pide un plan de ideas y lo espera como `prepare` (`RUN_WAIT`); al final, las ideas
 * por semana con su id y el comando para aceptarlas o descartarlas. Sale con 1 si el plan falla.
 */
export function runPlanRequest(deps: PlanDeps, options: PlanRequestOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const days = integerOption("--days", options.days);
    const count = integerOption("--count", options.count);
    const platforms = options.platform
      ?.flatMap((option) => collect(option))
      .map((option) => postPlatformOption(option));
    const brand = await brandOf(deps.client, options.broker);
    const { plan, reused } = await unwrap(
      deps.client.plans.$post({
        json: {
          brokerId: brand.id,
          ...(days === undefined ? {} : { days }),
          ...(count === undefined ? {} : { count }),
          ...(platforms === undefined ? {} : { platforms: [...new Set(platforms)] }),
          ...(options.start === undefined ? {} : { startDay: options.start.trim() }),
        },
      }),
      planRequestResponseSchema,
    ).catch((error: unknown) => {
      throw explained(error);
    });
    if (reused) {
      deps.printError(c.yellow("La marca ya tenía un plan en curso: sigo ese"));
    }
    if (options.wait === false) {
      deps.print(plan.id);
      deps.printError(c.dim(`→ Míralo con: ${show(plan.id)}`));
      return 0;
    }
    deps.print(`Plan ${plan.id} (${periodText(plan)}): ${PLAN_RUN_STATUS_TEXT[plan.status]}…`);
    const done = await waitForRun<PlanRunView>(deps, {
      run: plan,
      fetch: async () => (await fetchPlan(deps.client, plan.id)).plan,
      isTerminal: (run) => run.status === "succeeded" || run.status === "failed",
      progress: (run) => PLAN_RUN_STATUS_TEXT[run.status],
      laterCommand: show(plan.id),
      noun: "el plan",
    });
    if (done === null) return 1;
    deps.print("");
    deps.print(renderPlanDetail(await fetchPlan(deps.client, plan.id), brand.slug, c));
    return done.status === "succeeded" ? 0 : 1;
  });
}

/** `agentsales plan show <id> [--json]`. */
export function runPlanShow(deps: PlanDeps, id: string, options: { json?: boolean } = {}) {
  return guarded(deps, async () => {
    const detail = await fetchPlan(deps.client, planIdOf(id));
    if (options.json) {
      deps.print(JSON.stringify(detail, null, 2));
      return 0;
    }
    const brokers = await fetchBrokers(deps.client);
    deps.print(
      renderPlanDetail(
        detail,
        brokers.get(detail.plan.brokerId)?.slug ?? detail.plan.brokerId,
        deps.colors,
      ),
    );
    return detail.plan.status === "failed" ? 1 : 0;
  });
}

/** `agentsales plan list [--broker] [--json]`: los planes de la marca, los más recientes primero. */
export function runPlanList(deps: PlanDeps, options: { broker?: string; json?: boolean } = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const brand = await brandOf(deps.client, options.broker);
    const { plans } = await unwrap(
      deps.client.plans.$get({ query: { brokerId: brand.id } }),
      planListResponseSchema,
    ).catch((error: unknown) => {
      throw explained(error);
    });
    if (options.json) {
      deps.print(JSON.stringify({ plans }, null, 2));
      return 0;
    }
    if (plans.length === 0) {
      deps.print(c.yellow(`${brand.slug} no tiene planes: pide uno con agentsales plan`));
      return 0;
    }
    deps.print(
      renderTable(
        ["ID", "ESTADO", "PERÍODO", "REDES", "PEDIDO (CHILE)"],
        plans.map((plan) => [
          plan.id,
          paintStatus(plan, c),
          `${plan.firstDay} a ${plan.lastDay}`,
          plan.platforms.map((platform) => PLATFORM_TEXT[platform]).join(", "),
          formatChileTime(plan.createdAt),
        ]),
        c,
      ),
    );
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  const deps = (): PlanDeps => ({
    ...ctx,
    client: ctx.api(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => performance.now(),
  });
  const plan = program
    .command("plan")
    .description(
      "Pide a la IA un plan de ideas con fecha para la marca y espera (nada se publica solo)",
    )
    .option("--broker <slug>", "la marca (si ves más de una)")
    .option("--days <n>", `días del período, desde mañana (por defecto ${PLAN_DEFAULT_DAYS})`)
    .option(
      "--platform <red>",
      `solo esas redes: ${POST_PLATFORM_OPTION_NAMES.join(", ")} (repetible o separado por comas)`,
      collect,
    )
    .option("--count <n>", "cuántas ideas (por defecto, según la cadencia del perfil)")
    .option("--start <día>", "el primer día del período (AAAA-MM-DD, Chile; por defecto mañana)")
    .option("--no-wait", "imprime el id del plan y sale sin esperar")
    .action((options: PlanRequestOptions) => exitWith(() => runPlanRequest(deps(), options)));
  plan
    .command("show")
    .description("Un plan: su estado y sus ideas por semana, con el comando para cada una")
    .argument("<id>", "id del plan (agentsales plan list)")
    .option("--json", "salida en JSON")
    .action((id: string, options: { json?: boolean }) =>
      exitWith(() => runPlanShow(deps(), id, options)),
    );
  plan
    .command("list")
    .description("Los planes de la marca, los más recientes primero")
    .option("--broker <slug>", "la marca (si ves más de una)")
    .option("--json", "salida en JSON")
    .action((options: { broker?: string; json?: boolean }) =>
      exitWith(() => runPlanList(deps(), options)),
    );
}
