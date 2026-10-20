import { type AppError, isAppError } from "../errors.js";
import { MANUAL_CONFIRM_PLATFORMS, requiresManualConfirm } from "../marketplace/limits.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { ListingLock } from "../ports/listing-lock.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import type { Publication, PublicationError } from "../publication.js";
import { scrubMessage } from "../redact.js";
import { SCHEDULE_OVERDUE_MS } from "../schedule.js";
import { listingIdOf } from "../subject.js";
import {
  enqueuePublication,
  type MarketplaceStartOptions,
  type PortalCheckDeps,
  portalDefinitionsBeforeLock,
  startOne,
} from "./publication-start.js";
import { requireStartableOne } from "./start-checks.js";

/** Cuántas programadas empieza como mucho cada vuelta del disparo (spec F6 §4.4). */
export const DUE_BATCH_LIMIT = 20;

export type StartDueDeps = PortalCheckDeps & {
  lock: ListingLock;
  queue: JobQueue;
  /** Fuera del candado: las vencidas de la ventana. */
  publications: Pick<PublicationRepository, "listDue">;
  marketplace?: MarketplaceStartOptions;
  now?: () => Date;
};

export type StartDueResult = {
  /** Pasaron a `publishing` y se encolaron. */
  started: string[];
  /** Pasaron a `publishing` pero la cola no las recibió: las recoge la vigilancia o el arranque. */
  notQueued: string[];
  /** No se pudieron empezar: quedaron `failed` con el motivo. */
  failed: { publicationId: string; code: string }[];
  /** Otro cambio llegó antes (el operador la desprogramó, reprogramó o publicó). */
  skipped: string[];
  /** Un error pasajero (la base): siguen programadas y se reintentan en la próxima vuelta. */
  errors: { publicationId: string; code: string }[];
};

/**
 * El disparo de las programadas (job `publication.due`, spec F6 §4.4, ADR-0018): las `scheduled`
 * cuya hora venció hace 12 h o menos (`SCHEDULE_OVERDUE_MS`; las más atrasadas esperan al
 * operador), de plataformas sin paso manual (Marketplace es un recordatorio), por hora y como
 * mucho 20. Cada una, dentro del candado de su aviso:
 * - si sigue `scheduled` a esa hora y pasa la revisión de publicar (con el modo **de la
 *   publicación**, fijado al programar), `scheduled` → `publishing` (actor `system`) y se encola
 *   después del candado;
 * - si la revisión falla con un error no reintentable, `scheduled` → `failed` con el motivo;
 * - si otro cambio llegó antes, se salta.
 * Una que falla no corta las demás. Nada se lanza: el resultado dice qué pasó con cada una.
 */
export async function startDuePublications(deps: StartDueDeps): Promise<StartDueResult> {
  const now = (deps.now ?? (() => new Date()))();
  const due = await deps.publications.listDue({
    now,
    since: new Date(now.getTime() - SCHEDULE_OVERDUE_MS),
    excludePlatforms: [...MANUAL_CONFIRM_PLATFORMS],
    limit: DUE_BATCH_LIMIT,
  });
  const result: StartDueResult = {
    started: [],
    notQueued: [],
    failed: [],
    skipped: [],
    errors: [],
  };
  // `listDue` ve también las de posts (F9-T06); el disparo sigue siendo de avisos hasta F9-T07.
  // Hoy ningún post se programa (programar es de avisos), así que no ocupan lugares del lote.
  for (const candidate of due.filter((publication) => publication.subject.kind === "listing")) {
    try {
      const outcome = await startDueOne(deps, candidate, now);
      if (outcome === null) {
        result.skipped.push(candidate.id);
      } else if (outcome.status === "publishing") {
        try {
          await enqueuePublication(deps.queue, outcome.id);
          result.started.push(outcome.id);
        } catch {
          result.notQueued.push(outcome.id);
        }
      } else {
        result.failed.push({ publicationId: outcome.id, code: outcome.lastError?.code ?? "" });
      }
    } catch (error) {
      result.errors.push({
        publicationId: candidate.id,
        code: isAppError(error) ? error.code : "INTERNAL_ERROR",
      });
    }
  }
  return result;
}

/** Una programada vencida: la empieza, la deja `failed` o `null` si ya cambió. */
async function startDueOne(
  deps: StartDueDeps,
  candidate: Publication,
  now: Date,
): Promise<Publication | null> {
  const definitions = await portalDefinitionsBeforeLock(
    deps,
    listingIdOf(candidate.subject),
    candidate.platform,
  );
  return deps.lock.run(listingIdOf(candidate.subject), async (locked) => {
    const publication = await locked.publications.get(candidate.id);
    if (
      publication === null ||
      publication.status !== "scheduled" ||
      publication.scheduledAt?.getTime() !== candidate.scheduledAt?.getTime() ||
      // Segunda barrera (ADR-0017, ADR-0018): un recordatorio nunca abre Facebook solo, aunque
      // la consulta lo dejara pasar.
      requiresManualConfirm(publication.platform)
    ) {
      return null;
    }
    try {
      await requireStartableOne(locked, publication, {
        dryRun: publication.dryRun,
        definitions,
        marketplace: deps.marketplace ?? {},
        now,
        manualLimits: true,
      });
    } catch (error) {
      if (!isAppError(error) || error.retriable) throw error;
      return locked.publications.transition(
        publication.id,
        { from: "scheduled", to: "failed", changes: { lastError: lastErrorOf(error) } },
        {
          actor: "system",
          payload: { mode: publication.dryRun ? "dry-run" : "live", due: true, code: error.code },
        },
      );
    }
    return startOne(locked.publications, publication, {
      dryRun: publication.dryRun,
      actor: "system",
    });
  });
}

/** El motivo que queda en `last_error`, limpio como el del intento (`scrubMessage`). */
const lastErrorOf = (error: AppError): PublicationError => ({
  code: error.code,
  message: scrubMessage(error.message),
  retriable: error.retriable,
});
