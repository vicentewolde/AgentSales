import type { AbortSignalLike } from "../abort.js";
import { chileDateOf } from "../chile-time.js";
import { contentRunErrorOf } from "../content/run-error.js";
import { editorialProfileView } from "../editorial-profile.js";
import type { PlanRunStatus } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import { assertLlmBudget, llmProviderFor } from "../llm-budget.js";
import { llmCallCost } from "../llm-usage.js";
import type { PlanRun } from "../plan-run.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { ContentRunRepository } from "../ports/content-repository.js";
import type { EditorialProfileRepository } from "../ports/editorial-profile-repository.js";
import type { LLMProvider } from "../ports/llm-provider.js";
import type { PlanRunRepository } from "../ports/plan-run-repository.js";
import type { NewPost, PostRepository } from "../ports/post-repository.js";
import { profileSources } from "../social/check.js";
import {
  addDays,
  buildPlanBrief,
  PLAN_RECENT_DAYS,
  type PlanRunReport,
  planHistory,
  plannedSlots,
  planRunRequestSchema,
} from "../social/plan.js";
import { PLAN_PROMPT_VERSION } from "../social/plan-prompt.js";
import { proposePlanIdeas } from "../social/plan-propose.js";

// La corrida de un plan de ideas (el handler del job `content.plan`, spec F9 §4.9, ADR-0030).

const DAY_MS = 24 * 60 * 60 * 1000;

export type RunPlanDeps = {
  planRuns: Pick<
    PlanRunRepository,
    "get" | "markRunning" | "markSucceeded" | "markFailed" | "addLlmUsage"
  >;
  posts: Pick<PostRepository, "listRecent">;
  brokers: Pick<BrokerRepository, "findById">;
  editorialProfiles: Pick<EditorialProfileRepository, "get">;
  /** Para el tope de IA del mes (`sumLlmCost` suma también los planes). */
  contentRuns: Pick<ContentRunRepository, "sumLlmCost">;
  /** El proveedor del operador (`LLM_PROVIDER`): el de sus marcas propias (spec F7 §4.7). */
  llm: LLMProvider;
  /** La API de Anthropic para las marcas que no son del operador; `null` sin la clave. */
  apiLlm?: LLMProvider | null;
  /** El id de cada idea (un uuid): el reporte lo anota antes de guardarlas. */
  newId: () => string;
  /** Reloj en milisegundos, para la duración de la llamada a la IA. */
  now?: () => number;
  /** La fecha de las verificaciones (ideas en el pasado) y del tope del mes. Por defecto, la actual. */
  clock?: () => Date;
};

export type RunPlanParams = {
  planRunId: string;
  /** Último intento del job: un error deja el plan en `failed`. */
  isLastAttempt: boolean;
  /** El del worker: se dispara al apagarse. */
  signal?: AbortSignalLike;
};

export type RunPlanResult =
  | { outcome: "succeeded"; report: PlanRunReport }
  /** El plan ya estaba terminado, o un intento solapado guardó antes: no se hizo nada. */
  | { outcome: "skipped"; status: PlanRunStatus };

const TERMINAL: readonly PlanRunStatus[] = ["succeeded", "failed"];

const aborted = (cause?: unknown) =>
  new AppError("PLAN_RUN_ABORTED", "Se cortó el plan de ideas", {
    retriable: true,
    ...(cause === undefined ? {} : { cause }),
  });

const normalized = (error: unknown): AppError =>
  isAppError(error)
    ? error
    : new AppError("INTERNAL_ERROR", "Error interno al preparar el plan de ideas", {
        cause: error,
      });

/**
 * Corre un plan de ideas (spec F9 §4.9, ADR-0030):
 * 1. Lee el plan (lo pedido en `request`), su marca y su perfil editorial, y los temas que no se
 *    repiten (`planHistory`: los posts de los últimos 60 días y las ideas descartadas).
 * 2. Llama a la IA con el proveedor de la marca (`llmProviderFor`), revisa el tope del mes antes de
 *    cada llamada (`LLM_BUDGET_EXCEEDED`, F7) y anota cada llamada en el plan en cuanto vuelve
 *    (también si después falla: entra a `sumLlmCost`). La respuesta se valida con zod (con un
 *    reintento si el sobre no calza: `LLM_OUTPUT_INVALID` después).
 * 3. Verifica cada idea (`checkPlanIdeas`, dentro de `proposePlanIdeas`, que T22 usa sin la base):
 *    las que no pasan se descartan y quedan en el reporte. Lo ya planificado en el período
 *    (`plannedSlots`) ocupa su cupo de la semana.
 * 4. Guarda, en una transacción, el reporte con `succeeded` y un post `idea` por cada idea válida
 *    (`source = ai`, `brief_origin = ai`, `plan_run_id`, `planned_at`, `pillar`, `rationale` y sus
 *    redes, `platforms`),
 *    **sin textos ni publicaciones** (ADR-0030, puntos 2 y 4). Cero ideas válidas también es un
 *    plan terminado: el reporte dice por qué.
 * Como `draftPost`: un plan terminal no se toca (`skipped`); un error no reintentable, o el del
 * último intento, deja el plan en `failed` con su código (`LLM_*`, `DB_UNAVAILABLE`…), salvo que el
 * worker se esté apagando (`signal`): entonces relanza como reintentable sin tocarlo.
 */
export async function runPlan(
  deps: RunPlanDeps,
  { planRunId, isLastAttempt, signal }: RunPlanParams,
): Promise<RunPlanResult> {
  const run = await deps.planRuns.get(planRunId);
  if (run === null) {
    throw new AppError("PLAN_RUN_NOT_FOUND", `No existe el plan ${planRunId}`, {
      details: { planRunId },
    });
  }
  if (TERMINAL.includes(run.status)) return { outcome: "skipped", status: run.status };
  if (!(await deps.planRuns.markRunning(run.id))) return skipped(deps, run);

  try {
    if (signal?.aborted) throw aborted();
    const { report, ideas } = await propose(deps, run, signal);
    if (signal?.aborted) throw aborted();
    const saved = await saveIdeas(deps, run.id, report, ideas);
    if (!saved) return skipped(deps, run);
    return { outcome: "succeeded", report };
  } catch (caught) {
    const error = normalized(caught);
    if (signal?.aborted) throw error.retriable ? error : aborted(error);
    if (!error.retriable || isLastAttempt) {
      await deps.planRuns.markFailed(run.id, contentRunErrorOf(error)).catch(() => false);
    }
    throw error;
  }
}

/**
 * Guarda el reporte y las ideas. Si quien pidió el plan ya no existe (se borró el usuario entre el
 * pedido y la corrida: `POST_REFERENCE_INVALID` por `created_by`), las ideas se guardan sin autor
 * en vez de perder el plan, como el `ON DELETE SET NULL` de `posts.created_by`.
 */
async function saveIdeas(
  deps: RunPlanDeps,
  planRunId: string,
  report: PlanRunReport,
  ideas: NewPost[],
): Promise<boolean> {
  const save = (list: NewPost[]) =>
    deps.planRuns.markSucceeded(planRunId, {
      report,
      promptVersion: PLAN_PROMPT_VERSION,
      ideas: list,
    });
  try {
    return await save(ideas);
  } catch (error) {
    const withAuthor = ideas.some((idea) => idea.createdBy != null);
    if (!withAuthor || !isAppError(error) || error.code !== "POST_REFERENCE_INVALID") throw error;
    return save(ideas.map((idea) => ({ ...idea, createdBy: null })));
  }
}

async function skipped(deps: RunPlanDeps, run: PlanRun): Promise<RunPlanResult> {
  const current = await deps.planRuns.get(run.id);
  return { outcome: "skipped", status: current?.status ?? run.status };
}

/** El brief, la IA con su tope y su gasto, y las verificaciones de cada idea. */
async function propose(
  deps: RunPlanDeps,
  run: PlanRun,
  signal: AbortSignalLike | undefined,
): Promise<{ report: PlanRunReport; ideas: NewPost[] }> {
  const parsed = planRunRequestSchema.safeParse(run.request);
  if (!parsed.success) {
    throw new AppError("PLAN_RUN_INVALID", "El plan no tiene lo pedido en el formato esperado", {
      details: { planRunId: run.id },
    });
  }
  const request = parsed.data;
  const broker = await deps.brokers.findById(run.brokerId);
  if (broker === null) {
    throw new AppError("BROKER_NOT_FOUND", "No existe la marca del plan", {
      details: { planRunId: run.id },
    });
  }
  const profile = editorialProfileView(broker.id, await deps.editorialProfiles.get(broker.id));
  const clock = deps.clock ?? (() => new Date());
  const now = deps.now ?? Date.now;
  const today = clock();
  const recent = await deps.posts.listRecent(
    broker.id,
    new Date(today.getTime() - PLAN_RECENT_DAYS * DAY_MS),
  );
  const firstDay = chileDateOf(run.periodStart);
  const period = {
    firstDay,
    lastDay: addDays(firstDay, request.days - 1),
    days: request.days,
    start: run.periodStart,
    end: run.periodEnd,
  };
  const brief = buildPlanBrief({
    broker,
    profile,
    period,
    platforms: request.platforms,
    count: request.count,
    history: planHistory(recent, today),
    planned: plannedSlots(recent, period, request.platforms),
  });

  const started = now();
  // El proveedor de la marca y su tope del mes antes de cada llamada (spec F7 §4.7), con la marca
  // releída: el tope pudo cambiar entre medio.
  const llm = llmProviderFor(broker, { own: deps.llm, api: deps.apiLlm ?? null });
  const result = await proposePlanIdeas(
    {
      llm,
      beforeCall: async () => {
        const current = (await deps.brokers.findById(broker.id)) ?? broker;
        await assertLlmBudget(deps, current, clock());
      },
      // Cada llamada se anota en cuanto vuelve: también las que fallan después (se cobraron).
      onUsage: async (model, usage) => {
        await deps.planRuns.addLlmUsage(run.id, llmCallCost(llm.name, model, usage));
      },
    },
    {
      brief,
      period,
      sources: profileSources(profile, broker),
      now: clock(),
      ...(signal === undefined ? {} : { signal }),
    },
  );

  const ideas: NewPost[] = [];
  const report: PlanRunReport = {
    ideas: [],
    discarded: result.discarded,
    warnings: result.warnings,
    llm: {
      provider: llm.name,
      model: result.model,
      attempts: result.attempts,
      durationMs: Math.max(0, Math.round(now() - started)),
    },
  };
  for (const idea of result.ideas) {
    const id = deps.newId();
    ideas.push({
      id,
      brokerId: broker.id,
      topic: idea.topic,
      kind: idea.kind,
      brief: null,
      briefOrigin: "ai",
      status: "idea",
      source: "ai",
      pillar: idea.pillar,
      plannedAt: idea.plannedAt,
      planRunId: run.id,
      createdBy: request.requestedBy,
      rationale: idea.rationale,
      // Al aceptarla se redacta solo para estas (decisión del operador, F9-T20).
      platforms: idea.platforms,
    });
    report.ideas.push({
      postId: id,
      topic: idea.topic,
      pillar: idea.pillar,
      platforms: idea.platforms,
      kind: idea.kind,
      plannedAt: idea.plannedAt.toISOString(),
      notes: idea.notes,
    });
  }
  return { report, ideas };
}
