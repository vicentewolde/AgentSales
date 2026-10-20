import {
  type AbortSignalLike,
  AppError,
  isAppError,
  type MediaProcessor,
  type ProcessPostMediaDeps,
  processPostMedia,
} from "@agentsales/core";
import { createAttemptDir } from "../content-tmp.js";
import { defineJob, type Job, type QueuePolicy } from "./define.js";

/**
 * Política de `post.media` (spec F9 §4.5, F9-T10):
 * - `stately`: uno en cola y uno activo por `singletonKey = postId`. Así, una subida que termina
 *   mientras otra vuelta procesa el mismo post deja la siguiente en cola (con `exclusive` se
 *   perdería);
 * - 2 reintentos con backoff desde 30 s y 30 min por intento (un reel y el video para X de 90 s
 *   por video caben de sobra), como `content.prepare`.
 */
export const POST_MEDIA_QUEUE: QueuePolicy = {
  policy: "stately",
  retryLimit: 2,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 30 * 60,
};

export type PostMediaJobDeps = {
  /** Repositorios y R2 (sin el procesador, que es de cada intento). */
  shared: Omit<ProcessPostMediaDeps, "processor" | "onCleanupFailed">;
  /** El procesador de medios de un intento, con su directorio temporal. */
  createProcessor: (workDir: string) => MediaProcessor;
  /** `<workspace>/tmp/content`: el mismo de las corridas (se limpia al arrancar). */
  tmpRoot: string;
  /** Se dispara al apagar el worker: corta ffmpeg. */
  signal: AbortSignalLike;
};

const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/**
 * Job `post.media`: arma las variantes que faltan de los medios de un post (`processPostMedia`,
 * core) con un procesador y un temporal propios del intento, que se borra al terminar. El log
 * lleva solo conteos, ids y códigos.
 */
export function postMediaJob(deps: PostMediaJobDeps): Job {
  return defineJob({
    name: "post.media",
    queue: POST_MEDIA_QUEUE,
    errorLogFields: (error) => ({ code: codeOf(error) }),
    handler: async ({ postId }, { logger }) => {
      let dir: Awaited<ReturnType<typeof createAttemptDir>>;
      try {
        dir = await createAttemptDir(deps.tmpRoot, postId);
      } catch (cause) {
        throw new AppError(
          "CONTENT_TMP_UNAVAILABLE",
          "El worker no pudo crear su carpeta temporal (¿disco lleno?)",
          { retriable: true, cause },
        );
      }
      try {
        const result = await processPostMedia(
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
          { postId, signal: deps.signal },
        );
        if (result.outcome === "skipped") {
          logger.info({ reason: result.reason }, "post sin medios que procesar");
          return;
        }
        if (result.failedMediaIds.length > 0) {
          logger.warn(
            { mediaIds: result.failedMediaIds },
            "medios del post que no se pudieron leer (formato no válido o archivo dañado)",
          );
        }
        logger.info({ media: result.media }, "medios del post procesados");
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
