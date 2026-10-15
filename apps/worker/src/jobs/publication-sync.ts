import { isAppError, type SyncPublicationDeps, syncPublication } from "@agentsales/core";
import { defineJob, type Job, type QueuePolicy } from "./define.js";

/**
 * Política de `publication.sync` (spec F4 §4.9, `docs/01-arquitectura.md` → Cola de trabajos):
 * - `exclusive`: un solo sync en cola, en reintento o activo por `singletonKey = publicationId`;
 * - 2 reintentos con backoff desde 60 s (Mercado Libre caído, o la publicación cambió mientras se
 *   leía: `PUBLICATION_SYNC_STALE`);
 * - expira a los 2 min. Cada intento se corta a los 90 s (`PUBLICATION_SYNC_MAX_MS`): el peor
 *   caso sin tope (candado y refresco del token, 30 s por llamada, un 401 con su reintento y la
 *   moderación) pasaría de los 2 min. Un corte es reintentable y el sync solo lee.
 */
export const PUBLICATION_SYNC_QUEUE: QueuePolicy = {
  policy: "exclusive",
  retryLimit: 2,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: 120,
};

/** Tope de un intento del sync (desde la revisión de F4-T18), bajo los 2 min de la cola. */
export const PUBLICATION_SYNC_MAX_MS = 90_000;

/** El sync después de publicar en `live` (spec F4 §4.9): Mercado Libre activa el ítem al procesar las fotos. */
export const PUBLISHED_SYNC_DELAY_MS = 2 * 60 * 1000;

export type PublicationSyncJobDeps = {
  /** Repositorios, el candado, el token de Portal y las operaciones sin envolver. */
  shared: Omit<SyncPublicationDeps, "onWarning">;
  /** Se dispara al apagar el worker: corta la llamada a Mercado Libre. */
  signal: AbortSignal;
};

const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/**
 * Job `publication.sync`: corre `syncPublication` de core (spec F4 §4.9). Solo lee de la
 * plataforma, así que no mira el `PUBLISH_MODE` del worker: una publicación `live` se sincroniza
 * aunque el worker esté en `dry-run`, y una de `dry-run` se salta (`skipped`). Se registra solo el
 * resultado, el estado y los códigos, nunca tokens ni datos del aviso. Si en el **último** intento
 * la publicación cambió mientras se leía (`PUBLICATION_SYNC_STALE`), se registra como información y
 * se cierra el job: no es un fallo (el operador la cambió; el próximo sync la lee).
 */
export function publicationSyncJob(deps: PublicationSyncJobDeps): Job {
  return defineJob({
    name: "publication.sync",
    queue: PUBLICATION_SYNC_QUEUE,
    errorLogFields: (error) => ({
      code: codeOf(error),
      retriable: !isAppError(error) || error.retriable,
    }),
    handler: async ({ publicationId }, { logger, isLastAttempt }) => {
      try {
        const result = await syncPublication(
          {
            ...deps.shared,
            onWarning: ({ step, code }) =>
              logger.warn({ step, code }, "un paso secundario del sync falló"),
          },
          {
            publicationId,
            signal: AbortSignal.any([deps.signal, AbortSignal.timeout(PUBLICATION_SYNC_MAX_MS)]),
          },
        );
        if (result.outcome === "skipped") {
          logger.info({ reason: result.reason, status: result.status }, "sync: nada que leer");
        } else {
          logger.info(
            {
              remoteStatus: result.publication.remoteState?.status ?? null,
              changed: result.changed,
              listingBackToReady: result.listingBackToReady,
            },
            "sync: estado de la plataforma guardado",
          );
        }
      } catch (error) {
        if (isLastAttempt && isAppError(error) && error.code === "PUBLICATION_SYNC_STALE") {
          logger.info(
            { code: error.code },
            "sync: la publicación cambió mientras se leía; se lee en el próximo sync",
          );
          return;
        }
        throw error;
      }
    },
  });
}

/**
 * Al arrancar, con las colas creadas (spec F4 §4.9): encola el sync de las de Portal en vivo. La
 * lógica vive en core desde F6-T05 (la comparte la vigilancia de cada hora).
 */
export { enqueueLiveSyncs } from "@agentsales/core";
