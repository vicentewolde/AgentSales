import { isAppError } from "../errors.js";
import type { ImportRun } from "../import-run.js";
import type { ImportRunRepository, NewImportRun } from "../ports/import-run-repository.js";
import type { JobQueue } from "../ports/job-queue.js";

export type RequestImportDeps = {
  importRuns: ImportRunRepository;
  queue: JobQueue;
  /**
   * Borra los archivos que la API dejó en staging para este run (`tmp/imports/{id}/`); no falla
   * si no hay nada. Core no toca el disco: lo compone la API.
   */
  discardStaging: (runId: string) => Promise<void>;
};

/**
 * Pide una carga (spec F1 §4.6): crea el `import_run` en `queued` y encola `import.run` con
 * `singletonKey = importRunId`. Devuelve el run en `queued` (la API responde `202`).
 *
 * Si la cola no está disponible (`QUEUE_UNAVAILABLE`), el run pasa a `failed` con ese motivo, se
 * borra su staging y el error se propaga (la API responde `503`). Cualquier otro error se propaga
 * tal cual, sin tocar el run: un `JOB_PAYLOAD_INVALID` es un bug, no una caída de la cola.
 */
export async function requestImport(
  deps: RequestImportDeps,
  params: NewImportRun,
): Promise<ImportRun> {
  const run = await deps.importRuns.create(params);
  try {
    await deps.queue.enqueue("import.run", { importRunId: run.id }, { singletonKey: run.id });
  } catch (error) {
    if (isAppError(error) && error.code === "QUEUE_UNAVAILABLE") {
      // Si además falla la base o el disco, igual se informa el error de la cola: es la causa.
      await deps.importRuns
        .markFailed(run.id, { code: error.code, message: error.message })
        .catch(() => false);
      await deps.discardStaging(run.id).catch(() => undefined);
    }
    throw error;
  }
  return run;
}
