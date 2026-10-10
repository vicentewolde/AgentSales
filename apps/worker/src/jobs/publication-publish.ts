import type { Logger } from "@agentsales/config";
import {
  enqueuePublication,
  enqueueSync,
  isAppError,
  type JobQueue,
  OPERATION_PLATFORMS,
  type PublicationRepository,
  type PublishPublicationDeps,
  publishPublication,
} from "@agentsales/core";
import type { InstagramPublishNote } from "@agentsales/publishers";
import type { MarketplaceWindows } from "../marketplace/windows.js";
import { defineJob, type Job, type QueuePolicy } from "./define.js";
import { PUBLISHED_SYNC_DELAY_MS } from "./publication-sync.js";

/**
 * Política de `publication.publish` (spec F3 §4.4, `docs/01-arquitectura.md` → Cola de trabajos):
 * - `exclusive`: un solo job en cola, en reintento o activo por `singletonKey = publicationId`, así
 *   un intento nunca se cruza con otro de la misma publicación;
 * - 2 reintentos con backoff desde 60 s;
 * - expira a los 15 min: cada intento se corta a los 12 min (`PUBLICATION_ATTEMPT_MAX_MS`: el
 *   sondeo de un reel de Instagram, o hasta 30 fotos de Portal a 30 s cada una), y los 3 min de
 *   margen cubren lo que corre fuera (firmar las URLs, leer y guardar en la base). Así un intento
 *   nunca se cruza con su reintento: dos intentos de Portal a la vez podrían crear dos ítems.
 */
export const PUBLICATION_PUBLISH_QUEUE: QueuePolicy = {
  policy: "exclusive",
  retryLimit: 2,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: 15 * 60,
};

/**
 * Tope de un intento, cualquiera sea la plataforma (desde la revisión de F4-T18): al vencer, la señal
 * corta la llamada en curso y el intento queda en `publishing` (`PUBLISH_ABORTED`, reintentable),
 * como en un apagado; el reintento retoma desde el progreso (en Portal, sin repetir `POST /items` a
 * ciegas). Instagram tiene además su propio tope, igual.
 */
export const PUBLICATION_ATTEMPT_MAX_MS = 12 * 60_000;

export type PublicationPublishJobDeps = {
  /**
   * Lo que comparten los intentos: repositorios, R2, los publishers (el de Instagram registrado en
   * los dos modos, con su cliente perezoso) y el `PUBLISH_MODE` del worker.
   */
  shared: Omit<PublishPublicationDeps, "onWarning">;
  /** Para el sync de Portal 2 min después de publicar en `live` (spec F4 §4.9). */
  queue: JobQueue;
  /** Se dispara al apagar el worker: corta el sondeo y las llamadas a la plataforma. */
  signal: AbortSignal;
  /** Reloj para el `startAfter` del sync (los tests fijan uno). */
  now?: () => Date;
  /**
   * Las ventanas de Marketplace (spec F5 §4.5): la del formulario listo se vigila recién cuando el
   * intento terminó en `awaiting_manual_confirm`; en cualquier otra salida se cierra.
   */
  marketplaceWindows?: Pick<MarketplaceWindows, "activate" | "discard">;
};

/** Solo el código: el mensaje o la causa de un error pueden traer el caption o datos del aviso. */
const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/**
 * Job `publication.publish`: corre `publishPublication` de core (spec F3 §4.4). El modo lo decide
 * la publicación; core deja el estado (`published`, sigue en `publishing` o `failed`) y aquí solo
 * se registra, con el `publicationId` (en los datos del job), el código y el resultado: nunca
 * tokens, URLs firmadas ni el caption. Un error no reintentable ya dejó la publicación en `failed`:
 * el registro lo anota y cierra el job; uno reintentable sube para que pg-boss reintente. Una de
 * Portal publicada en `live` encola su sync en 2 min (`enqueueSync`): el ítem suele nacer pausado
 * mientras Mercado Libre procesa las fotos. Si encolarlo falla, se avisa y el job termina bien (el
 * sync al arrancar o Actualizar lo cubren).
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
      const windows = deps.marketplaceWindows;
      let result: Awaited<ReturnType<typeof publishPublication>>;
      try {
        result = await publishPublication(
          {
            ...deps.shared,
            onWarning: ({ step, code }) =>
              logger.warn({ step, code }, "un paso secundario de la publicación falló"),
          },
          {
            publicationId,
            isLastAttempt,
            retryCount,
            signal: AbortSignal.any([deps.signal, AbortSignal.timeout(PUBLICATION_ATTEMPT_MAX_MS)]),
          },
        );
      } catch (error) {
        // El formulario no quedó guardado como listo: su ventana (si la había) no se vigila.
        await windows?.discard(publicationId);
        throw error;
      }
      if (result.outcome === "awaiting_manual_confirm") {
        const watching = (await windows?.activate(publicationId)) ?? false;
        logger.info(
          { mode: result.publication.dryRun ? "dry-run" : "live", watching },
          "formulario de Marketplace listo: espera el clic final del operador",
        );
        return;
      }
      await windows?.discard(publicationId);
      if (result.outcome === "skipped") {
        logger.info({ status: result.status }, "la publicación no estaba en curso: nada que hacer");
      } else if (result.publication.dryRun) {
        logger.info({ mode: "dry-run" }, "publicación simulada (dry-run): no se envió nada");
      } else {
        logger.info({ mode: "live" }, "publicación publicada");
        if (OPERATION_PLATFORMS.has(result.publication.platform)) {
          const now = deps.now ?? (() => new Date());
          try {
            const jobId = await enqueueSync(deps.queue, publicationId, {
              startAfter: new Date(now().getTime() + PUBLISHED_SYNC_DELAY_MS),
            });
            if (jobId === null) logger.info("ya había un sync de la publicación en la cola");
          } catch (error) {
            logger.warn(
              { code: codeOf(error) },
              "no se pudo encolar el sync de la publicación: lo hace el arranque o Actualizar",
            );
          }
        }
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
