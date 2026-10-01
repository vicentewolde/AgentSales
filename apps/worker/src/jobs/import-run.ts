import { type RunImportDeps, runImport } from "@agentsales/core";
import { defineJob, type Job, type QueuePolicy } from "./define.js";

/**
 * Política de `import.run` (spec F1 §4.6, `docs/01-arquitectura.md` → Cola de trabajos):
 * - `exclusive`: un solo job en cola, en reintento o activo por `singletonKey = importRunId`. Es
 *   inmutable: se fija al crear la cola por primera vez;
 * - 2 reintentos con backoff desde 30 s;
 * - expira a las 2 h: varios videos de 300 MB con una subida doméstica pueden tardar (pg-boss no
 *   aborta un intento que expira).
 */
export const IMPORT_RUN_QUEUE: QueuePolicy = {
  policy: "exclusive",
  retryLimit: 2,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 2 * 60 * 60,
};

/** Job `import.run`: delgado, corre `runImport` de core con las dependencias del worker. */
export function importRunJob(deps: RunImportDeps): Job {
  return defineJob({
    name: "import.run",
    queue: IMPORT_RUN_QUEUE,
    handler: async ({ importRunId }, { logger, isLastAttempt }) => {
      const result = await runImport(deps, { importRunId, isLastAttempt });
      logger.info(
        result.outcome === "skipped" ? { status: result.status } : {},
        result.outcome === "skipped"
          ? "la carga ya había terminado: nada que hacer"
          : "carga terminada",
      );
    },
  });
}
