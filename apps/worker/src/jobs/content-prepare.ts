import {
  type AbortSignalLike,
  AppError,
  type ContentRunReport,
  type ContentRunRepository,
  enqueueContentRun,
  isAppError,
  type JobQueue,
  type MediaProcessor,
  type PrepareContentDeps,
  prepareContent,
} from "@agentsales/core";
import { createAttemptDir } from "../content-tmp.js";
import { defineJob, type Job, type QueuePolicy } from "./define.js";

/**
 * Política de `content.prepare` (spec F2 §4.4, `docs/01-arquitectura.md` → Cola de trabajos):
 * - `exclusive`: un solo job en cola, en reintento o activo por `singletonKey = contentRunId`;
 * - 2 reintentos con backoff desde 30 s;
 * - expira a los 30 min: un reel de 90 s, los renders y la IA con su reintento caben de sobra.
 */
export const CONTENT_PREPARE_QUEUE: QueuePolicy = {
  policy: "exclusive",
  retryLimit: 2,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 30 * 60,
};

/**
 * Una corrida en `running` más vieja que esto ya no tiene un intento vivo: los 3 intentos de 30
 * min y media hora de margen (que cubre el backoff de 30 y 60 s). Son 2 h.
 */
export const CONTENT_RUN_ABANDONED_AFTER_MS =
  ((CONTENT_PREPARE_QUEUE.retryLimit + 1) * CONTENT_PREPARE_QUEUE.expireInSeconds + 30 * 60) * 1000;

/** Motivo de una corrida cerrada por abandonada (el proceso murió o la base no respondió). */
export const CONTENT_RUN_ABANDONED = {
  code: "CONTENT_RUN_ABANDONED",
  message:
    "La preparación quedó a medias (el worker se detuvo o perdió la conexión): vuelve a pedirla",
};

export type ContentPrepareJobDeps = {
  /** Lo que comparten los intentos: repositorios, R2, plantillas, renderizador, IA y sha256. */
  shared: Omit<PrepareContentDeps, "processor" | "onCleanupFailed">;
  /** El procesador de medios de un intento, con su directorio temporal (spec F2 §4.2). */
  createProcessor: (workDir: string) => MediaProcessor;
  /** `<workspace>/tmp/content`. */
  tmpRoot: string;
  /** Se dispara al apagar el worker: corta los procesos hijos (ffmpeg, Chromium, la CLI de Claude). */
  signal: AbortSignalLike;
};

/** Solo el código: el mensaje o la causa de un error pueden traer datos del aviso (spec F2 §4.9). */
const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/** Lo que se registra de una corrida terminada: conteos, nunca las advertencias (traen el aviso). */
const summaryOf = (report: ContentRunReport) => ({
  media: report.media,
  renders: report.renders,
  reel: report.reel,
  warnings: report.warnings.length,
  llm:
    report.llm === undefined
      ? undefined
      : {
          provider: report.llm.provider,
          attempts: report.llm.attempts,
          durationMs: report.llm.durationMs,
        },
});

/**
 * Job `content.prepare`: corre `prepareContent` de core con un procesador y un directorio temporal
 * propios de cada intento, que se borra al terminar, también si falla.
 * - Un corte por apagado se relanza como reintentable (`CONTENT_RUN_ABORTED`) aunque el adaptador
 *   haya dado otro error: la corrida sigue en `running` y la retoma pg-boss al volver a arrancar.
 * - El log de un error lleva solo su código (y los datos del job, el `contentRunId`).
 */
export function contentPrepareJob(deps: ContentPrepareJobDeps): Job {
  return defineJob({
    name: "content.prepare",
    queue: CONTENT_PREPARE_QUEUE,
    errorLogFields: (error) => ({ code: codeOf(error) }),
    handler: async ({ contentRunId }, { logger, isLastAttempt }) => {
      const dir = await createAttemptDir(deps.tmpRoot, contentRunId);
      try {
        const result = await prepareContent(
          {
            ...deps.shared,
            processor: deps.createProcessor(dir.path),
            // La clave de R2 solo lleva ids; `objectPath` y no `…Key`, que el log ocultaría.
            onCleanupFailed: (objectPath, error) =>
              logger.warn(
                { objectPath, code: codeOf(error) },
                "no se pudo borrar un archivo viejo de R2: queda sin uso",
              ),
          },
          { contentRunId, isLastAttempt, signal: deps.signal },
        );
        if (result.outcome === "skipped") {
          logger.info({ status: result.status }, "la corrida ya había terminado: nada que hacer");
        } else {
          logger.info(summaryOf(result.report), "contenido preparado");
        }
      } catch (error) {
        if (deps.signal.aborted && !(isAppError(error) && error.retriable)) {
          throw new AppError("CONTENT_RUN_ABORTED", "Se cortó la corrida de contenido", {
            retriable: true,
            cause: error,
          });
        }
        throw error;
      } finally {
        await dir
          .remove()
          .catch((error: unknown) =>
            logger.warn(
              { code: codeOf(error) },
              "no se pudo borrar el temporal del intento: se borra al arrancar dentro de 24 h",
            ),
          );
      }
    },
  });
}

/**
 * Al arrancar: cierra como `failed` (`CONTENT_RUN_ABANDONED`) las corridas en `running` con
 * `started_at` de hace más de 2 h. Las `queued` no se tocan: se reencolan. Devuelve los ids.
 */
export function failAbandonedContentRuns(
  contentRuns: Pick<ContentRunRepository, "failAbandoned">,
  now = Date.now(),
): Promise<string[]> {
  return contentRuns.failAbandoned(
    new Date(now - CONTENT_RUN_ABANDONED_AFTER_MS),
    CONTENT_RUN_ABANDONED,
  );
}

/**
 * Al arrancar, con las colas ya creadas: reencola **todas** las corridas `queued` (spec F2 §4.4).
 * Con el worker apagado, una corrida puede esperar días y su pedido sigue valiendo; si su job sigue
 * en la cola, `singletonKey` no lo duplica. Devuelve cuántas se reencolaron.
 */
export async function requeueQueuedContentRuns(
  contentRuns: Pick<ContentRunRepository, "listQueued">,
  queue: JobQueue,
): Promise<number> {
  const queued = await contentRuns.listQueued();
  for (const run of queued) await enqueueContentRun(queue, run.id);
  return queued.length;
}
