import {
  type AbortSignalLike,
  AppError,
  isAppError,
  type JobQueue,
  type MediaProcessor,
  type PostImageRunRepository,
  type RunPostImageDeps,
  runPostImage,
} from "@agentsales/core";
import { createAttemptDir } from "../content-tmp.js";
import { defineJob, type Job, type QueuePolicy } from "./define.js";

/**
 * Política de `post.image` (F9.5-T25, ADR-0038):
 * - `exclusive` por `singletonKey = postImageRunId` (un pedido, un job);
 * - 2 reintentos con backoff desde 30 s (una caída de Pixabay o de la IA; un 429 de la biblioteca
 *   pide esperar un minuto) y 15 min por intento (el video de las tarjetas es el más largo).
 */
export const POST_IMAGE_QUEUE: QueuePolicy = {
  policy: "exclusive",
  retryLimit: 2,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 15 * 60,
};

export type PostImageJobDeps = {
  /** Repositorios, R2, el candado del post, las tarjetas y los proveedores (sin el procesador). */
  shared: Omit<RunPostImageDeps, "processor">;
  /** El procesador de medios de un intento (el video de las tarjetas), con su temporal. */
  createProcessor: (workDir: string) => MediaProcessor;
  /** `<workspace>/tmp/content`: el mismo de las corridas (se limpia al arrancar). */
  tmpRoot: string;
  /** Se dispara al apagar el worker: corta ffmpeg y las descargas. */
  signal: AbortSignalLike;
};

/** Solo el código: el mensaje o la causa pueden traer la indicación o la búsqueda. */
const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/**
 * Job `post.image`: corre `runPostImage` de core (tarjetas, biblioteca o IA) con un procesador y un
 * temporal propios del intento, que se borra al terminar. El log lleva solo ids, conteos y
 * códigos: nunca la búsqueda, la indicación ni una URL.
 */
export function postImageJob(deps: PostImageJobDeps): Job {
  return defineJob({
    name: "post.image",
    queue: POST_IMAGE_QUEUE,
    errorLogFields: (error) => ({ code: codeOf(error) }),
    handler: async ({ postImageRunId }, { logger, isLastAttempt }) => {
      let dir: Awaited<ReturnType<typeof createAttemptDir>>;
      try {
        dir = await createAttemptDir(deps.tmpRoot, postImageRunId);
      } catch (cause) {
        throw new AppError(
          "CONTENT_TMP_UNAVAILABLE",
          "El worker no pudo crear su carpeta temporal (¿disco lleno?)",
          { retriable: true, cause },
        );
      }
      try {
        const result = await runPostImage(
          { ...deps.shared, processor: deps.createProcessor(dir.path) },
          { runId: postImageRunId, isLastAttempt, signal: deps.signal },
        );
        if (result.outcome === "skipped") {
          logger.info("el pedido de imágenes ya había terminado: nada que hacer");
        } else if (result.outcome === "failed") {
          logger.warn({ code: result.code }, "no se consiguió la imagen del post");
        } else {
          logger.info(
            {
              media: result.mediaIds.length,
              created: result.created,
              replaced: result.replaced,
            },
            "imágenes del post conseguidas",
          );
          // Archivos de tarjetas quitadas que R2 no borró: quedan sueltos (son claves, sin firma).
          if (result.leftover.length > 0) {
            logger.warn(
              { leftover: result.leftover },
              "no se pudieron borrar de R2 las tarjetas anteriores: quedan sueltas en el bucket",
            );
          }
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
 * Un pedido en `running` que empezó hace más de esto quedó abandonado (el worker se apagó a medias):
 * tres intentos de 15 min con su espera caben de sobra.
 */
export const POST_IMAGE_RUN_ABANDONED_AFTER_MS = 2 * 60 * 60 * 1000;

export const POST_IMAGE_RUN_ABANDONED = {
  code: "POST_IMAGE_RUN_ABANDONED",
  message: "El pedido de imágenes se cortó (el worker se detuvo): vuelve a pedirlo",
};

/**
 * Al arrancar, antes de registrar los jobs: cierra como `failed` los pedidos en `running` de más de
 * 2 h (`POST_IMAGE_RUN_ABANDONED`), como `failAbandonedContentRuns`. Devuelve sus ids.
 */
export function failAbandonedPostImageRuns(
  runs: Pick<PostImageRunRepository, "failAbandoned">,
  now = Date.now(),
): Promise<string[]> {
  return runs.failAbandoned(
    new Date(now - POST_IMAGE_RUN_ABANDONED_AFTER_MS),
    POST_IMAGE_RUN_ABANDONED,
  );
}

/**
 * Al arrancar, con las colas ya creadas: reencola los pedidos en `queued` como `post.image` (con el
 * worker apagado, un pedido espera y sigue valiendo; `singletonKey` no lo duplica). Uno que falla no
 * corta los demás.
 */
export async function requeueQueuedPostImageRuns(
  runs: Pick<PostImageRunRepository, "listQueued">,
  queue: JobQueue,
): Promise<{ requeued: number; failed: string[] }> {
  const failed: string[] = [];
  let requeued = 0;
  for (const run of await runs.listQueued()) {
    try {
      await queue.enqueue("post.image", { postImageRunId: run.id }, { singletonKey: run.id });
      requeued += 1;
    } catch {
      failed.push(run.id);
    }
  }
  return { requeued, failed };
}
