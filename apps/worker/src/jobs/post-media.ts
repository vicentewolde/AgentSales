import {
  type AbortSignalLike,
  AppError,
  type FinalizePostUploadsDeps,
  finalizePostUploads,
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
  /**
   * Las subidas grandes sin sha256 (F9-T17): el candado del post, R2 y el sha256 en streaming. Se
   * revisan antes de armar las variantes, así su medio nuevo entra en la misma vuelta.
   */
  uploads: FinalizePostUploadsDeps;
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
 * core) con un procesador y un temporal propios del intento, que se borra al terminar: de una
 * foto, `thumb` e `ig_4x5`; de un video, `thumb`, el reel sin texto y `x_video`; y, si el post va a
 * Discord y el más liviano de su primer video pasa de 20 MiB, `discord_video` (F9.5 D8). Si ese no
 * se puede o su pasada falla, queda un aviso en el log y el post sigue sin él (Discord publica el
 * texto solo). El log lleva solo conteos, ids y códigos.
 */
export function postMediaJob(deps: PostMediaJobDeps): Job {
  return defineJob({
    name: "post.media",
    queue: POST_MEDIA_QUEUE,
    errorLogFields: (error) => ({ code: codeOf(error) }),
    handler: async ({ postId }, { logger }) => {
      const finalized = await finalizePostUploads(deps.uploads, { postId, signal: deps.signal });
      const { created, duplicates, missing } = finalized;
      if (created.length + duplicates.length + missing.length > 0) {
        logger.info(
          { created: created.length, duplicates: duplicates.length, missing: missing.length },
          "subidas grandes del post revisadas",
        );
      }
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
            onDiscordVideoMissing: (mediaId, reason, error) => {
              if (reason === "failed") {
                logger.warn(
                  { mediaId, code: codeOf(error) },
                  "no se pudo armar el video para Discord: se publicará el texto solo",
                );
              } else {
                logger.info(
                  { mediaId, reason },
                  "el video no cabe en Discord ni a bitrate bajo: se publicará el texto solo",
                );
              }
            },
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
