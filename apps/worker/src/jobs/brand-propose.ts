import {
  type AbortSignalLike,
  isAppError,
  type RunKnowledgeProposalsDeps,
  runKnowledgeProposals,
} from "@agentsales/core";
import { defineJob, type Job, type QueuePolicy } from "./define.js";

/**
 * Política de `brand.propose` (spec F9.7 B2, ADR-0043), la misma de `content.plan`: una llamada a la
 * IA con su reintento por formato; exclusiva por corrida (`singletonKey = knowledgeRunId`).
 */
export const BRAND_PROPOSE_QUEUE: QueuePolicy = {
  policy: "exclusive",
  retryLimit: 2,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 25 * 60,
};

export type BrandProposeJobDeps = {
  shared: RunKnowledgeProposalsDeps;
  signal: AbortSignalLike;
};

/** Solo el código: el mensaje o la causa pueden traer el texto del operador. */
const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/**
 * Job `brand.propose`: corre `runKnowledgeProposals` de core. El log lleva solo ids, conteos y
 * códigos, nunca el texto pegado ni las propuestas.
 */
export function brandProposeJob(deps: BrandProposeJobDeps): Job {
  return defineJob({
    name: "brand.propose",
    queue: BRAND_PROPOSE_QUEUE,
    errorLogFields: (error) => ({ code: codeOf(error) }),
    handler: async ({ knowledgeRunId }, { logger, isLastAttempt }) => {
      const result = await runKnowledgeProposals(deps.shared, {
        knowledgeRunId,
        isLastAttempt,
        signal: deps.signal,
      });
      if (result.outcome === "skipped") {
        logger.info({ status: result.status }, "la lectura ya había terminado: nada que hacer");
        return;
      }
      logger.info({ proposals: result.proposals }, "propuestas de conocimiento listas");
    },
  });
}
