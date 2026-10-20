import { type AbortSignalLike, type DraftPostDeps, draftPost, isAppError } from "@agentsales/core";
import { defineJob, type Job, type QueuePolicy } from "./define.js";

/**
 * Política de `post.draft` (spec F9 §4.9, F9-T11):
 * - `exclusive`: un solo job en cola, en reintento o activo por `singletonKey = contentRunId`
 *   (`enqueuePostDraft`);
 * - 2 reintentos con backoff desde 30 s;
 * - expira a los 25 min: dos llamadas a la IA (la primera y el reintento por formato) con el tope
 *   máximo de `LLM_TIMEOUT_SECONDS` (600 s) caben. Los tres intentos y el backoff suman 76,5 min,
 *   dentro de las 2 h tras las que `failAbandoned` cierra una corrida (`CONTENT_RUN_ABANDONED_AFTER_MS`).
 */
export const POST_DRAFT_QUEUE: QueuePolicy = {
  policy: "exclusive",
  retryLimit: 2,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 25 * 60,
};

export type PostDraftJobDeps = {
  /** Repositorios, el candado del post y la IA (la del operador y la API). */
  shared: DraftPostDeps;
  /** Se dispara al apagar el worker: corta la llamada a la IA. */
  signal: AbortSignalLike;
};

/** Solo el código: el mensaje o la causa de un error pueden traer datos del post. */
const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/**
 * Job `post.draft`: corre `draftPost` de core (los textos de un post, un texto por red e idioma).
 * El corte por apagado lo resuelve core (la corrida queda en `running` y el error sube como
 * reintentable). El log lleva solo ids, conteos y códigos, nunca los textos ni el brief.
 */
export function postDraftJob(deps: PostDraftJobDeps): Job {
  return defineJob({
    name: "post.draft",
    queue: POST_DRAFT_QUEUE,
    errorLogFields: (error) => ({ code: codeOf(error) }),
    handler: async ({ contentRunId }, { logger, isLastAttempt }) => {
      const result = await draftPost(deps.shared, {
        contentRunId,
        isLastAttempt,
        signal: deps.signal,
      });
      if (result.outcome === "skipped") {
        logger.info({ status: result.status }, "la corrida ya había terminado: nada que hacer");
        return;
      }
      const { report } = result;
      logger.info(
        {
          postStatus: result.postStatus,
          texts: report.postChecks?.length ?? 0,
          withChecks: report.postChecks?.filter((item) => item.codes.length > 0).length ?? 0,
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
        "textos del post redactados",
      );
    },
  });
}
