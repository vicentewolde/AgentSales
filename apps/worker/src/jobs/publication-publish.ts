import type { Logger } from "@agentsales/config";
import {
  type AbortSignalLike,
  enqueuePublication,
  isAppError,
  type JobQueue,
  type PublicationRepository,
  type PublishPublicationDeps,
  publishPublication,
} from "@agentsales/core";
import type { InstagramPublishNote } from "@agentsales/publishers";
import { defineJob, type Job, type QueuePolicy } from "./define.js";

/**
 * Política de `publication.publish` (spec F3 §4.4, `docs/01-arquitectura.md` → Cola de trabajos):
 * - `exclusive`: un solo job en cola, en reintento o activo por `singletonKey = publicationId`, así
 *   un intento nunca se cruza con otro de la misma publicación;
 * - 2 reintentos con backoff desde 60 s;
 * - expira a los 15 min: el intento tiene su propio tope de 12 min (sondeo de un reel de hasta
 *   5 min, más el carrusel); los 3 min de margen cubren lo que corre fuera de ese tope (firmar las
 *   URLs, leer y guardar en la base). Si un intento llegara a cruzarse con su reintento, subirlo.
 */
export const PUBLICATION_PUBLISH_QUEUE: QueuePolicy = {
  policy: "exclusive",
  retryLimit: 2,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: 15 * 60,
};

export type PublicationPublishJobDeps = {
  /**
   * Lo que comparten los intentos: repositorios, R2, los publishers (el de Instagram registrado en
   * los dos modos, con su cliente perezoso) y el `PUBLISH_MODE` del worker.
   */
  shared: Omit<PublishPublicationDeps, "onWarning">;
  /** Se dispara al apagar el worker: corta el sondeo y las llamadas a la plataforma. */
  signal: AbortSignalLike;
};

/** Solo el código: el mensaje o la causa de un error pueden traer el caption o datos del aviso. */
const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/**
 * Job `publication.publish`: corre `publishPublication` de core (spec F3 §4.4). El modo lo decide
 * la publicación; core deja el estado (`published`, sigue en `publishing` o `failed`) y aquí solo
 * se registra, con el `publicationId` (en los datos del job), el código y el resultado: nunca
 * tokens, URLs firmadas ni el caption. Un error no reintentable ya dejó la publicación en `failed`:
 * el registro lo anota y cierra el job; uno reintentable sube para que pg-boss reintente.
 */
export function publicationPublishJob(deps: PublicationPublishJobDeps): Job {
  return defineJob({
    name: "publication.publish",
    queue: PUBLICATION_PUBLISH_QUEUE,
    // `retriable` como lo ve el registro: lo que no es `AppError` sube y pg-boss lo reintenta.
    errorLogFields: (error) => ({
      code: codeOf(error),
      retriable: !isAppError(error) || error.retriable,
    }),
    handler: async ({ publicationId }, { logger, isLastAttempt, retryCount }) => {
      const result = await publishPublication(
        {
          ...deps.shared,
          onWarning: ({ step, code }) =>
            logger.warn({ step, code }, "un paso secundario de la publicación falló"),
        },
        { publicationId, isLastAttempt, retryCount, signal: deps.signal },
      );
      if (result.outcome === "skipped") {
        logger.info({ status: result.status }, "la publicación no estaba en curso: nada que hacer");
      } else if (result.publication.dryRun) {
        logger.info({ mode: "dry-run" }, "publicación simulada (dry-run): no se envió nada");
      } else {
        logger.info({ mode: "live" }, "publicación publicada");
      }
    },
  });
}

/**
 * Al arrancar, con las colas ya creadas: reencola **todas** las publicaciones en `publishing`
 * (spec F3 §4.4). Es lo que recupera una que se quedó sin job (un apagado en el último intento, una
 * cola caída al publicar); si su job sigue en la cola, `singletonKey` no lo duplica. Una que falla
 * no corta las demás: devuelve cuántas se reencolaron y los ids de las que no.
 */
export async function requeuePublishingPublications(
  publications: Pick<PublicationRepository, "listByStatus">,
  queue: JobQueue,
): Promise<{ requeued: number; failed: string[] }> {
  const failed: string[] = [];
  let requeued = 0;
  for (const publication of await publications.listByStatus("publishing")) {
    try {
      await enqueuePublication(queue, publication.id);
      requeued += 1;
    } catch {
      failed.push(publication.id);
    }
  }
  return { requeued, failed };
}

/**
 * Las notas del publisher de Instagram (`onNote`, por ejemplo el cupo que no respondió) al log del
 * proceso: el publisher es uno por proceso, así que la nota lleva el `publicationId` y no el job.
 */
export const instagramNoteLogger =
  (logger: Logger) =>
  ({ publicationId, code, errorCode }: InstagramPublishNote) =>
    logger.info({ publicationId, code, errorCode }, "nota del publicador de Instagram");
