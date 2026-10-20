import { inScope } from "../access.js";
import { editorialProfileView } from "../editorial-profile.js";
import { isPostPlatform, type PostPlatform } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import { assertLlmBudget } from "../llm-budget.js";
import { assertCan, scopeOf } from "../permissions.js";
import type { PlanRun } from "../plan-run.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { ContentRunRepository } from "../ports/content-repository.js";
import type { EditorialProfileRepository } from "../ports/editorial-profile-repository.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { PlanRunRepository } from "../ports/plan-run-repository.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import type { PostRepository } from "../ports/post-repository.js";
import { postPlatforms } from "../social/brief.js";
import {
  defaultPlanCount,
  PLAN_MAX_IDEAS,
  type PlanRunReport,
  type PlanRunRequest,
  planPeriod,
  planRunReportSchema,
} from "../social/plan.js";
import type { User } from "../user.js";

// Pedir un plan de ideas (spec F9 §4.9, ADR-0030): crea el `plan_run` en `queued` y, ya
// confirmado, encola `content.plan` (el patrón de `requestContentRun`). Lo atiende `runPlan`.

type Actor = Pick<User, "id" | "role" | "brokerId">;

const invalid = (message: string, details: Record<string, unknown> = {}) =>
  new AppError("PLAN_RUN_INVALID", message, { details });

const brokerNotFound = (brokerId: string) =>
  new AppError("BROKER_NOT_FOUND", `No existe el corredor ${brokerId}`, {
    details: { id: brokerId },
  });

const planNotFound = (planRunId: string) =>
  new AppError("PLAN_RUN_NOT_FOUND", `No existe el plan ${planRunId}`, {
    details: { planRunId },
  });

/**
 * Encola el job de un plan (`content.plan`), idempotente con `singletonKey` (cola `exclusive`): lo
 * usan `requestPlanRun` y el worker, que reencola los planes en cola al arrancar.
 */
export const enqueuePlanRun = (queue: JobQueue, planRunId: string) =>
  queue.enqueue("content.plan", { planRunId }, { singletonKey: planRunId });

export type RequestPlanRunDeps = {
  brokers: Pick<BrokerRepository, "findById">;
  editorialProfiles: Pick<EditorialProfileRepository, "get">;
  platformAccounts: Pick<PlatformAccountRepository, "listByBroker">;
  planRuns: Pick<PlanRunRepository, "create" | "listByBroker" | "markFailed">;
  /** Para el tope de IA del mes (`sumLlmCost` suma también los planes). */
  contentRuns: Pick<ContentRunRepository, "sumLlmCost">;
  queue: JobQueue;
  /** El reloj (el período por defecto y el tope del mes); por defecto, la hora actual. */
  now?: () => Date;
};

export type RequestPlanRunInput = {
  /** La marca o el corredor del plan; el de un usuario corredor es siempre el suyo. */
  brokerId?: string | undefined;
  /** El primer día del período (`AAAA-MM-DD`, hora de Chile); por defecto, mañana. */
  startDay?: string | undefined;
  /** Los días del período (1 a 31); por defecto, 14. */
  days?: number | undefined;
  /** Las redes; por defecto, todas las de la marca (`postPlatforms`). */
  platforms?: readonly string[] | undefined;
  /** Cuántas ideas (1 a 20); por defecto, según la cadencia (`defaultPlanCount`). */
  count?: number | undefined;
};

export type RequestPlanRunResult = {
  run: PlanRun;
  /** `true` si la marca ya tenía un plan en cola o corriendo: se devuelve ese (y se reencola). */
  reused: boolean;
};

/**
 * Pide un plan de ideas (`POST /api/plans`, `agentsales plan`, spec F9 §4.9):
 * - la marca: el administrador la elige (obligatoria); un corredor pide para la suya (otra es
 *   `BROKER_NOT_FOUND`, como una que no existe) y necesita `posts.manage`;
 * - las redes: las pedidas, que deben ser de la marca (`postPlatforms`: con cuenta o con cadencia
 *   en su perfil), o todas las suyas. Sin ninguna, `POST_NO_PLATFORMS` (409);
 * - el período (`planPeriod`) y cuántas ideas (`defaultPlanCount`); fuera de rango,
 *   `PLAN_RUN_INVALID` (400);
 * - con la marca en su tope de IA del mes, `LLM_BUDGET_EXCEEDED` (409; el worker lo revisa otra vez
 *   antes de llamar);
 * - si la marca ya tiene un plan en `queued` o `running`, lo devuelve (`reused`) y lo vuelve a
 *   encolar (idempotente), como `requestContentRun`; la base admite uno solo (índice único
 *   parcial): si dos pedidos se cruzan, el segundo recibe el del primero;
 * - si no, crea el plan en `queued` y, ya creado, encola `content.plan`. Si la cola no está
 *   (`QUEUE_UNAVAILABLE`, 503), el plan nuevo queda en `failed` con ese motivo.
 */
export async function requestPlanRun(
  deps: RequestPlanRunDeps,
  actor: Actor,
  input: RequestPlanRunInput,
): Promise<RequestPlanRunResult> {
  const now = (deps.now ?? (() => new Date()))();
  const brokerId = input.brokerId ?? actor.brokerId ?? undefined;
  if (brokerId === undefined) throw invalid("Falta la marca o el corredor del plan");
  if (!inScope(scopeOf(actor), brokerId)) throw brokerNotFound(brokerId);
  assertCan(actor, "posts.manage", brokerId);
  const broker = await deps.brokers.findById(brokerId);
  if (broker === null) throw brokerNotFound(brokerId);

  const profile = editorialProfileView(brokerId, await deps.editorialProfiles.get(brokerId));
  const available = postPlatforms(profile, await deps.platformAccounts.listByBroker(brokerId));
  if (available.length === 0) {
    throw new AppError(
      "POST_NO_PLATFORMS",
      "La marca no tiene redes para el plan: conecta una cuenta o define la cadencia de una red en su perfil editorial",
      { details: { brokerId } },
    );
  }
  let platforms: PostPlatform[] = available;
  if (input.platforms !== undefined && input.platforms.length > 0) {
    const asked = [...new Set(input.platforms.map((platform) => platform.trim().toLowerCase()))];
    const unknown = asked.filter(
      (platform) => !isPostPlatform(platform) || !available.includes(platform),
    );
    if (unknown.length > 0) {
      throw invalid(
        `La marca no publica en ${unknown.join(", ")}: sus redes son ${available.join(", ")}`,
        { platforms: unknown.map((platform) => platform.slice(0, 20)) },
      );
    }
    platforms = available.filter((platform) => asked.includes(platform));
  }
  const period = planPeriod({
    now,
    ...(input.startDay === undefined ? {} : { startDay: input.startDay }),
    ...(input.days === undefined ? {} : { days: input.days }),
  });
  const count = input.count ?? defaultPlanCount(profile.cadence, platforms, period.days);
  if (!Number.isInteger(count) || count < 1 || count > PLAN_MAX_IDEAS) {
    throw invalid(`Un plan pide de 1 a ${PLAN_MAX_IDEAS} ideas`, { count });
  }
  await assertLlmBudget(deps, broker, now);

  const owner: string = brokerId;
  const request: PlanRunRequest = { platforms, count, days: period.days, requestedBy: actor.id };
  const result = (await activePlanOf(deps, owner)) ?? (await createPlan());

  /** Crea el plan; si otro pedido ganó la carrera (`PLAN_RUN_CONFLICT`), devuelve ese. */
  async function createPlan(): Promise<RequestPlanRunResult> {
    try {
      const run = await deps.planRuns.create({
        brokerId: owner,
        periodStart: period.start,
        periodEnd: period.end,
        request,
      });
      return { run, reused: false };
    } catch (error) {
      if (!isAppError(error) || error.code !== "PLAN_RUN_CONFLICT") throw error;
      const active = await activePlanOf(deps, owner);
      if (active === null) throw error;
      return active;
    }
  }

  // Ya creado: encolar (también uno activo, por si su job se perdió).
  try {
    await enqueuePlanRun(deps.queue, result.run.id);
  } catch (error) {
    if (!result.reused && isAppError(error) && error.code === "QUEUE_UNAVAILABLE") {
      // Si además falla la base, igual se informa el error de la cola: es la causa.
      await deps.planRuns
        .markFailed(result.run.id, { code: error.code, message: error.message })
        .catch(() => false);
    }
    throw error;
  }
  return result;
}

/** El plan de la marca en `queued` o `running`, si tiene (hay como mucho uno: índice único). */
async function activePlanOf(
  deps: Pick<RequestPlanRunDeps, "planRuns">,
  brokerId: string,
): Promise<RequestPlanRunResult | null> {
  const active = (await deps.planRuns.listByBroker(brokerId)).find(
    (run) => run.status === "queued" || run.status === "running",
  );
  return active === undefined ? null : { run: active, reused: true };
}

/** Un plan con sus ideas, para la API, la CLI y el panel (T21). */
export type PlanRunView = {
  run: PlanRun;
  /** El reporte leído con su esquema; `null` mientras corre, si falló o si no se pudo leer. */
  report: PlanRunReport | null;
  /** Los posts que nacieron del plan (en cualquier estado: aceptados, descartados…). */
  ideas: Awaited<ReturnType<PostRepository["list"]>>;
};

/**
 * Un plan del alcance con sus ideas (`GET /api/plans/:id`): `PLAN_RUN_NOT_FOUND` si no existe o es
 * de otra marca (ADR-0022: lo ajeno no existe); sin `posts.manage`, `FORBIDDEN`.
 */
export async function getPlanRun(
  deps: {
    planRuns: Pick<PlanRunRepository, "get">;
    posts: Pick<PostRepository, "list">;
  },
  actor: Actor,
  planRunId: string,
): Promise<PlanRunView> {
  const run = await deps.planRuns.get(planRunId);
  const scope = scopeOf(actor);
  if (run === null || !inScope(scope, run.brokerId)) throw planNotFound(planRunId);
  assertCan(actor, "posts.manage", run.brokerId);
  const parsed = planRunReportSchema.safeParse(run.report);
  return {
    run,
    report: run.status === "succeeded" && parsed.success ? parsed.data : null,
    ideas: await deps.posts.list({ planRunId, brokerId: run.brokerId }, scope),
  };
}

/** Cuántos planes da `listPlanRuns`, por defecto y como mucho. */
export const PLAN_RUNS_LIST_LIMIT = { default: 20, max: 100 } as const;

/**
 * Los planes de una marca, los más recientes primero (`GET /api/plans?brokerId`, T21). El
 * administrador elige la marca (obligatoria: `PLAN_RUN_INVALID`); un corredor ve los suyos y otra
 * marca no existe para él (`BROKER_NOT_FOUND`); sin `posts.manage`, `FORBIDDEN`. `limit` de 1 a
 * 100 (por defecto 20).
 */
export async function listPlanRuns(
  deps: { planRuns: Pick<PlanRunRepository, "listByBroker"> },
  actor: Actor,
  input: { brokerId?: string | undefined; limit?: number | undefined } = {},
): Promise<PlanRun[]> {
  const brokerId = input.brokerId ?? actor.brokerId ?? undefined;
  if (brokerId === undefined) throw invalid("Falta la marca o el corredor de los planes");
  if (!inScope(scopeOf(actor), brokerId)) throw brokerNotFound(brokerId);
  assertCan(actor, "posts.manage", brokerId);
  const limit = input.limit ?? PLAN_RUNS_LIST_LIMIT.default;
  if (!Number.isInteger(limit) || limit < 1 || limit > PLAN_RUNS_LIST_LIMIT.max) {
    throw invalid(`Se listan de 1 a ${PLAN_RUNS_LIST_LIMIT.max} planes`, { limit });
  }
  return deps.planRuns.listByBroker(brokerId, limit);
}
