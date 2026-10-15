import {
  isAppError,
  type JobQueue,
  type StartDueDeps,
  startDuePublications,
} from "@agentsales/core";
import { defineJob, type Job, type JobSchedule, type QueuePolicy } from "./define.js";

/**
 * Clave fija de `publication.due`: con la cola `exclusive`, la vuelta del arranque y la del cron
 * nunca corren a la vez ni se acumulan (spec F6 §4.4).
 */
export const PUBLICATION_DUE_KEY = "publication.due";

/**
 * Política de `publication.due` (spec F6 §4.14, ADR-0018): `exclusive` con clave fija, sin
 * reintentos (la vuelta del minuto siguiente es el reintento) y 2 min de vida.
 */
export const PUBLICATION_DUE_QUEUE: QueuePolicy = {
  policy: "exclusive",
  retryLimit: 0,
  retryDelay: 0,
  retryBackoff: false,
  expireInSeconds: 2 * 60,
};

/**
 * Cada minuto, en hora de Chile. Un minuto perdido con el worker apagado no se repite
 * (`missed: "skip"`): lo cubre la vuelta del arranque, con la regla de atrasadas (12 h, D2).
 */
export const PUBLICATION_DUE_SCHEDULE: JobSchedule<"publication.due"> = {
  cron: "* * * * *",
  tz: "America/Santiago",
  data: {},
  singletonKey: PUBLICATION_DUE_KEY,
};

export type PublicationDueJobDeps = Omit<StartDueDeps, "now"> & { now?: () => Date };

const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/**
 * Job `publication.due`: corre `startDuePublications` (core). El log lleva solo ids y códigos.
 * Una vuelta sin nada que hacer no escribe en el log (corre cada minuto).
 */
export function publicationDueJob(deps: PublicationDueJobDeps): Job {
  return defineJob({
    name: "publication.due",
    queue: PUBLICATION_DUE_QUEUE,
    schedule: PUBLICATION_DUE_SCHEDULE,
    errorLogFields: (error) => ({ code: codeOf(error) }),
    handler: async (_data, { logger }) => {
      const result = await startDuePublications(deps);
      if (result.started.length > 0) {
        logger.info({ publicationIds: result.started }, "publicaciones programadas empezadas");
      }
      if (result.failed.length > 0) {
        logger.warn(
          { failed: result.failed },
          "publicaciones programadas que no se pudieron empezar: quedaron fallidas con el motivo",
        );
      }
      if (result.notQueued.length > 0) {
        logger.warn(
          { publicationIds: result.notQueued },
          "publicaciones programadas sin job (la cola no respondió): las recoge la vigilancia o el próximo arranque",
        );
      }
      if (result.errors.length > 0) {
        logger.warn(
          { errors: result.errors },
          "publicaciones programadas que no se pudieron revisar: se reintentan en el próximo minuto",
        );
      }
    },
  });
}

/** Encola la vuelta del arranque; si ya hay una en cola o en curso, `singletonKey` no la repite. */
export const enqueuePublicationDue = (queue: JobQueue) =>
  queue.enqueue("publication.due", {}, { singletonKey: PUBLICATION_DUE_KEY });
