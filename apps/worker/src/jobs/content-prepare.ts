import type { Logger } from "@agentsales/config";
import {
  type AbortSignalLike,
  AppError,
  type AutoPublishDeps,
  type AutoPublishResult,
  autoPublishListing,
  type ContentRunReport,
  type ContentRunRepository,
  enqueueContentRun,
  isAppError,
  type JobQueue,
  listingIdOf,
  type MediaProcessor,
  type PrepareContentDeps,
  prepareContent,
  type ResumeAutoPublishDeps,
  resumeCutAutoPublish,
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
  /**
   * `auto_publish` (spec F6 §4.10): al terminar bien una corrida con textos, aprueba y publica si el
   * corredor lo tiene activado. Sin esto, la corrida no publica nada (los tests que no lo ejercen).
   */
  autoPublish?: AutoPublishDeps;
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
 * El temporal del intento. Si no se puede crear (disco lleno, permisos), es
 * `CONTENT_TMP_UNAVAILABLE` (reintentable); en el último intento deja la corrida en `failed`, como
 * haría `prepareContent`: sin eso quedaría en cola sin job.
 */
async function attemptDir(deps: ContentPrepareJobDeps, contentRunId: string, last: boolean) {
  try {
    return await createAttemptDir(deps.tmpRoot, contentRunId);
  } catch (cause) {
    const error = new AppError(
      "CONTENT_TMP_UNAVAILABLE",
      "El worker no pudo crear su carpeta temporal (¿disco lleno?)",
      { retriable: true, cause },
    );
    if (last && !deps.signal.aborted) {
      await deps.shared.contentRuns
        .markFailed(contentRunId, { code: error.code, message: error.message })
        .catch(() => false);
    }
    throw error;
  }
}

/**
 * Job `content.prepare`: corre `prepareContent` de core con un procesador y un directorio temporal
 * propios de cada intento, que se borra al terminar, también si falla. El corte por apagado lo
 * resuelve core (la corrida queda en `running` y el error sube como reintentable). El log de un
 * error lleva solo su código (y los datos del job, el `contentRunId`).
 */
export function contentPrepareJob(deps: ContentPrepareJobDeps): Job {
  return defineJob({
    name: "content.prepare",
    queue: CONTENT_PREPARE_QUEUE,
    errorLogFields: (error) => ({ code: codeOf(error) }),
    handler: async ({ contentRunId }, { logger, isLastAttempt }) => {
      const dir = await attemptDir(deps, contentRunId, isLastAttempt);
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
          await autoPublishAfter(deps, contentRunId, logger);
        }
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
 * `auto_publish` después de una corrida terminada con textos (spec F6 §4.10). Nunca hace fallar la
 * corrida: un error se registra con su código (sin datos del aviso) y queda en la agenda. Al final
 * (también si no aplicaba o falló) anota que se resolvió: solo una corrida cortada antes de este
 * punto queda pendiente para el arranque (F8-T12).
 */
async function autoPublishAfter(
  deps: ContentPrepareJobDeps,
  contentRunId: string,
  logger: Logger,
): Promise<void> {
  try {
    if (deps.autoPublish === undefined) return;
    const run = await deps.shared.contentRuns.get(contentRunId);
    if (run === null || !run.texts) return;
    // `content.prepare` es de avisos: una corrida de post aquí es un error (se registra abajo).
    const listingId = listingIdOf(run.subject);
    logAutoPublish(listingId, await autoPublishListing(deps.autoPublish, { listingId }), logger);
  } catch (error) {
    logger.warn({ code: codeOf(error) }, "auto_publish falló: la corrida queda como estaba");
  } finally {
    await deps.shared.contentRuns
      .markAutoPublishDone(contentRunId)
      .catch((error: unknown) =>
        logger.warn(
          { code: codeOf(error) },
          "no se pudo anotar el auto_publish: al arrancar se revisa de nuevo",
        ),
      );
  }
}

/** Registra el resultado de cada canal de un `auto_publish` (sin datos del aviso). */
function logAutoPublish(listingId: string, result: AutoPublishResult, logger: Logger): void {
  if (result.outcome === "off") return;
  const failed = result.channels.filter((channel) => channel.result === "failed");
  const fields = {
    listingId,
    channels: result.channels.map(({ platform, result: outcome, code }) => ({
      platform,
      result: outcome,
      ...(code === undefined ? {} : { code }),
    })),
  };
  if (failed.length > 0) logger.warn(fields, "auto_publish: un canal no se pudo publicar");
  else logger.info(fields, "auto_publish: propiedad aprobada y publicada");
}

/**
 * Al arrancar (spec F8 §4.10, T12): retoma los `auto_publish` cortados (`resumeCutAutoPublish`,
 * core) y registra cada uno con solo ids, códigos y resultados. Devuelve cuántos se retomaron.
 */
export async function resumeAutoPublishAtStart(
  deps: ResumeAutoPublishDeps,
  logger: Logger,
  now?: Date,
): Promise<number> {
  const results = await resumeCutAutoPublish(deps, now === undefined ? {} : { now });
  for (const item of results) {
    if (item.outcome === "resumed") logAutoPublish(item.listingId, item.result, logger);
    else if (item.outcome === "failed") {
      logger.warn(
        { listingId: item.listingId, code: item.code },
        "no se pudo retomar un auto_publish cortado: queda para el operador",
      );
    } else if (item.reason === "touched") {
      logger.info(
        { listingId: item.listingId },
        "auto_publish cortado: la propiedad ya tiene publicaciones nuevas, no se retoma",
      );
    }
  }
  return results.filter((item) => item.outcome === "resumed").length;
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
 * en la cola, `singletonKey` no lo duplica. Una que falla no corta las demás: devuelve cuántas se
 * reencolaron y los ids de las que no.
 */
export async function requeueQueuedContentRuns(
  contentRuns: Pick<ContentRunRepository, "listQueued">,
  queue: JobQueue,
): Promise<{ requeued: number; failed: string[] }> {
  const failed: string[] = [];
  let requeued = 0;
  for (const run of await contentRuns.listQueued()) {
    try {
      await enqueueContentRun(queue, run.id);
      requeued += 1;
    } catch {
      failed.push(run.id);
    }
  }
  return { requeued, failed };
}
