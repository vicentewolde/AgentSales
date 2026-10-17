import {
  isAppError,
  type OAuthStateRepository,
  purgeExpiredAuth,
  type SessionRepository,
  type WatchPublicationsDeps,
  watchPublications,
} from "@agentsales/core";
import { defineJob, type Job, type JobSchedule, type QueuePolicy } from "./define.js";

/**
 * Clave fija de `publications.watch`: con la cola `exclusive`, dos vueltas nunca corren a la vez
 * ni se acumulan (spec F6 §4.6).
 */
export const PUBLICATIONS_WATCH_KEY = "publications.watch";

/**
 * Política de `publications.watch` (spec F6 §4.14, ADR-0018 punto 8): `exclusive` con clave fija,
 * 1 reintento desde 60 s y 5 min de vida (solo lee la base y encola).
 */
export const PUBLICATIONS_WATCH_QUEUE: QueuePolicy = {
  policy: "exclusive",
  retryLimit: 1,
  retryDelay: 60,
  retryBackoff: false,
  expireInSeconds: 5 * 60,
};

/**
 * Cada hora en punto, en hora de Chile. Al arrancar el worker no se encola: el arranque ya corre
 * directo el sync de Portal y el reencolado de todas las `publishing` (también Marketplace), y una
 * vuelta encolada con la misma clave podría quedar absorbida por el cron.
 */
export const PUBLICATIONS_WATCH_SCHEDULE: JobSchedule<"publications.watch"> = {
  cron: "0 * * * *",
  tz: "America/Santiago",
  data: {},
  singletonKey: PUBLICATIONS_WATCH_KEY,
};

export type PublicationsWatchJobDeps = WatchPublicationsDeps & {
  /** F7: borrar las sesiones y los `state` de OAuth vencidos en cada vuelta. */
  authCleanup?: {
    sessions: Pick<SessionRepository, "deleteExpired">;
    oauthStates: Pick<OAuthStateRepository, "deleteExpired">;
  };
};

const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/**
 * Job `publications.watch`: corre `watchPublications` (core) y registra solo conteos, ids y
 * códigos. Una vuelta sin nada que hacer no escribe más que el inicio y el fin del job. Después
 * borra las sesiones y los `state` de OAuth vencidos (F7); si falla, solo lo advierte.
 */
export function publicationsWatchJob(deps: PublicationsWatchJobDeps): Job {
  return defineJob({
    name: "publications.watch",
    queue: PUBLICATIONS_WATCH_QUEUE,
    schedule: PUBLICATIONS_WATCH_SCHEDULE,
    errorLogFields: (error) => ({ code: codeOf(error) }),
    handler: async (_data, { logger }) => {
      const { syncs, requeued, alreadyQueued, requeueFailed } = await watchPublications(deps);
      if (syncs.enqueued + syncs.alreadyQueued > 0) {
        logger.info(
          { enqueued: syncs.enqueued, alreadyQueued: syncs.alreadyQueued },
          "vigilancia: sync de las publicaciones de Portal encolado",
        );
      }
      if (syncs.failed.length > 0) {
        logger.warn({ failed: syncs.failed }, "vigilancia: no se pudo encolar algún sync");
      }
      if (requeued.length > 0) {
        logger.warn(
          { publicationIds: requeued },
          "vigilancia: publicaciones atascadas en publicando, reencoladas",
        );
      }
      if (alreadyQueued.length > 0) {
        logger.info(
          { publicationIds: alreadyQueued },
          "vigilancia: publicaciones largas en publicando que todavía tienen su job en la cola",
        );
      }
      if (requeueFailed.length > 0) {
        logger.warn(
          { failed: requeueFailed },
          "vigilancia: no se pudieron reencolar algunas publicaciones atascadas",
        );
      }
      if (deps.authCleanup !== undefined) {
        try {
          const purged = await purgeExpiredAuth(
            deps.authCleanup,
            (deps.now ?? (() => new Date()))(),
          );
          if (purged.sessions + purged.oauthStates > 0) {
            logger.info(purged, "vigilancia: sesiones y estados de OAuth vencidos borrados");
          }
        } catch (error) {
          logger.warn(
            { code: codeOf(error) },
            "vigilancia: no se pudieron borrar las sesiones vencidas",
          );
        }
      }
    },
  });
}
