import { isAppError } from "../errors.js";
import { MANUAL_CONFIRM_PLATFORMS } from "../marketplace/limits.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import { enqueueSync, OPERATION_PLATFORMS } from "./publication-operations.js";
import { enqueuePublication } from "./publication-start.js";

/**
 * Una `publishing` sin cambios desde hace más que esto se da por atascada (spec F6 §4.6): un intento
 * legítimo con 3 reintentos (12 min cada uno y 1, 2 y 4 min de espera) puede durar unos 55 min.
 */
export const STALE_PUBLISHING_MS = 70 * 60 * 1000;

const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

export type LiveSyncsResult = {
  enqueued: number;
  alreadyQueued: number;
  failed: Array<{ publicationId: string; code: string }>;
};

/**
 * Encola el sync de cada publicación de Portal en `live` que está `published` o `paused` y cuya
 * cuenta sigue `connected` (sin cuenta, el sync solo daría `ACCOUNT_NOT_CONNECTED`; spec F4 §4.9).
 * `singletonKey` no duplica uno pendiente (`alreadyQueued`). Una que falla no corta las demás. Lo
 * usan el arranque del worker y la vigilancia de cada hora (F6).
 */
export async function enqueueLiveSyncs(
  publications: Pick<PublicationRepository, "listByStatus">,
  platformAccounts: Pick<PlatformAccountRepository, "get">,
  queue: JobQueue,
): Promise<LiveSyncsResult> {
  const candidates = [
    ...(await publications.listByStatus("published")),
    ...(await publications.listByStatus("paused")),
  ].filter((publication) => !publication.dryRun && OPERATION_PLATFORMS.has(publication.platform));
  const connected = new Map<string, boolean>();
  const result: LiveSyncsResult = { enqueued: 0, alreadyQueued: 0, failed: [] };
  for (const publication of candidates) {
    try {
      let isConnected = connected.get(publication.platformAccountId);
      if (isConnected === undefined) {
        isConnected =
          (await platformAccounts.get(publication.platformAccountId))?.status === "connected";
        connected.set(publication.platformAccountId, isConnected);
      }
      if (!isConnected) continue;
      if ((await enqueueSync(queue, publication.id)) === null) result.alreadyQueued += 1;
      else result.enqueued += 1;
    } catch (error) {
      result.failed.push({ publicationId: publication.id, code: codeOf(error) });
    }
  }
  return result;
}

export type WatchPublicationsDeps = {
  publications: Pick<PublicationRepository, "listByStatus" | "listStalePublishing">;
  platformAccounts: Pick<PlatformAccountRepository, "get">;
  queue: JobQueue;
  now?: () => Date;
};

export type WatchPublicationsResult = {
  syncs: LiveSyncsResult;
  /** Las `publishing` atascadas que se reencolaron (si ya tenían job, la cola no lo duplicó). */
  requeued: string[];
  /** Las que no se pudieron reencolar, con su código. */
  requeueFailed: Array<{ publicationId: string; code: string }>;
};

/**
 * La vigilancia de cada hora (job `publications.watch`, spec F6 §4.6, ADR-0018 punto 8):
 * 1. encola el sync de Portal en vivo (`enqueueLiveSyncs`);
 * 2. reencola las `publishing` sin cambios desde hace más de 70 min (deuda de F3: un corte o un
 *    resultado sin guardar en el último intento las dejaba sin job hasta el próximo arranque),
 *    **salvo Marketplace**: un formulario nunca se reabre sin el operador (D7); esas quedan
 *    atascadas en la agenda. `enqueuePublication` es `exclusive` por publicación: si todavía tiene
 *    job, no se duplica.
 * Nada se lanza por una publicación: el resultado dice qué pasó. Lo que falla al listar sube.
 */
export async function watchPublications(
  deps: WatchPublicationsDeps,
): Promise<WatchPublicationsResult> {
  const now = (deps.now ?? (() => new Date()))();
  const syncs = await enqueueLiveSyncs(deps.publications, deps.platformAccounts, deps.queue);
  const stale = await deps.publications.listStalePublishing({
    before: new Date(now.getTime() - STALE_PUBLISHING_MS),
    excludePlatforms: [...MANUAL_CONFIRM_PLATFORMS],
  });
  const requeued: string[] = [];
  const requeueFailed: Array<{ publicationId: string; code: string }> = [];
  for (const publication of stale) {
    try {
      await enqueuePublication(deps.queue, publication.id);
      requeued.push(publication.id);
    } catch (error) {
      requeueFailed.push({ publicationId: publication.id, code: codeOf(error) });
    }
  }
  return { syncs, requeued, requeueFailed };
}
