import {
  type AbortSignalLike,
  enqueuePlanRun,
  isAppError,
  type JobQueue,
  type PlanRunRepository,
  type RunPlanDeps,
  runPlan,
} from "@agentsales/core";
import { defineJob, type Job, type QueuePolicy } from "./define.js";

/**
 * Política de `content.plan` (spec F9 §4.9, F9-T20), la misma de `post.draft`: una llamada a la IA
 * con su reintento por formato.
 * - `exclusive`: un solo job en cola, en reintento o activo por `singletonKey = planRunId`
 *   (`enqueuePlanRun`);
 * - 2 reintentos con backoff desde 30 s (la IA o la base que no responden);
 * - expira a los 25 min: dos llamadas con el tope máximo de `LLM_TIMEOUT_SECONDS` (600 s) caben.
 */
export const CONTENT_PLAN_QUEUE: QueuePolicy = {
  policy: "exclusive",
  retryLimit: 2,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 25 * 60,
};

/**
 * Un plan en `running` más viejo que esto ya no tiene un intento vivo: los 3 intentos de 25 min y
 * media hora de margen (que cubre el backoff). Son 105 min.
 */
export const PLAN_RUN_ABANDONED_AFTER_MS =
  ((CONTENT_PLAN_QUEUE.retryLimit + 1) * CONTENT_PLAN_QUEUE.expireInSeconds + 30 * 60) * 1000;

/** Motivo de un plan cerrado por abandonado (el proceso murió o la base no respondió). */
export const PLAN_RUN_ABANDONED = {
  code: "PLAN_RUN_ABANDONED",
  message: "El plan quedó a medias (el worker se detuvo o perdió la conexión): vuelve a pedirlo",
};

export type ContentPlanJobDeps = {
  /** Repositorios, la IA (la del operador y la API) y el id de las ideas. */
  shared: RunPlanDeps;
  /** Se dispara al apagar el worker: corta la llamada a la IA. */
  signal: AbortSignalLike;
};

/** Solo el código: el mensaje o la causa de un error pueden traer datos de la marca. */
const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/**
 * Job `content.plan`: corre `runPlan` de core (las ideas de un plan, ADR-0030). El corte por apagado
 * lo resuelve core (el plan queda en `running` y el error sube como reintentable). El log lleva
 * solo ids, conteos y códigos, nunca los temas ni el perfil.
 */
export function contentPlanJob(deps: ContentPlanJobDeps): Job {
  return defineJob({
    name: "content.plan",
    queue: CONTENT_PLAN_QUEUE,
    errorLogFields: (error) => ({ code: codeOf(error) }),
    handler: async ({ planRunId }, { logger, isLastAttempt }) => {
      const result = await runPlan(deps.shared, { planRunId, isLastAttempt, signal: deps.signal });
      if (result.outcome === "skipped") {
        logger.info({ status: result.status }, "el plan ya había terminado: nada que hacer");
        return;
      }
      const { report } = result;
      logger.info(
        {
          ideas: report.ideas.length,
          discarded: report.discarded.length,
          discardCodes: [...new Set(report.discarded.map((item) => item.code))],
          warnings: report.warnings.length,
          llm:
            report.llm === undefined
              ? undefined
              : {
                  provider: report.llm.provider,
                  attempts: report.llm.attempts,
                  durationMs: report.llm.durationMs,
                },
        },
        "plan de ideas listo",
      );
    },
  });
}

/**
 * Al arrancar: cierra como `failed` (`PLAN_RUN_ABANDONED`) los planes en `running` con `started_at`
 * de hace más de `PLAN_RUN_ABANDONED_AFTER_MS`. Los `queued` no se tocan: se reencolan.
 */
export function failAbandonedPlanRuns(
  planRuns: Pick<PlanRunRepository, "failAbandoned">,
  now = Date.now(),
): Promise<string[]> {
  return planRuns.failAbandoned(new Date(now - PLAN_RUN_ABANDONED_AFTER_MS), PLAN_RUN_ABANDONED);
}

/**
 * Al arrancar, con las colas ya creadas: reencola los planes en `queued` como `content.plan`. Con
 * el worker apagado, un plan puede esperar y su pedido sigue valiendo; si su job sigue en la cola,
 * `singletonKey` no lo duplica. Uno que falla no corta los demás.
 */
export async function requeueQueuedPlanRuns(
  planRuns: Pick<PlanRunRepository, "listQueued">,
  queue: JobQueue,
): Promise<{ requeued: number; failed: string[] }> {
  const failed: string[] = [];
  let requeued = 0;
  for (const run of await planRuns.listQueued()) {
    try {
      await enqueuePlanRun(queue, run.id);
      requeued += 1;
    } catch {
      failed.push(run.id);
    }
  }
  return { requeued, failed };
}
