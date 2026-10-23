import { type AppError, isAppError } from "../errors.js";
import { MANUAL_CONFIRM_PLATFORMS, requiresManualConfirm } from "../marketplace/limits.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { DueQuery, PublicationRepository } from "../ports/publication-repository.js";
import type { Publication, PublicationError } from "../publication.js";
import { scrubMessage } from "../redact.js";
import { SCHEDULE_OVERDUE_MS } from "../schedule.js";
import { runOnSubject, type SubjectLocks } from "../subject-lock.js";
import {
  enqueuePublication,
  type MarketplaceStartOptions,
  type PortalCheckDeps,
  startOne,
  subjectDefinitionsBeforeLock,
} from "./publication-start.js";
import { requireStartableOne } from "./start-checks.js";

/** Cuántas programadas empieza como mucho cada vuelta del disparo (spec F6 §4.4). */
export const DUE_BATCH_LIMIT = 20;

/**
 * Las programadas que el disparo empieza (`listDue`): vencidas hace 12 h o menos
 * (`SCHEDULE_OVERDUE_MS`), sin los recordatorios de Marketplace, como mucho `DUE_BATCH_LIMIT`. Con
 * `aheadMs`, también las que vencen en ese margen: el worker no se apaga solo mientras haya alguna
 * (F9.5-T24, ADR-0037). Una sola regla para los dos.
 */
export function dueQuery(now: Date, aheadMs = 0): DueQuery {
  return {
    now: new Date(now.getTime() + aheadMs),
    since: new Date(now.getTime() - SCHEDULE_OVERDUE_MS),
    excludePlatforms: [...MANUAL_CONFIRM_PLATFORMS],
    limit: DUE_BATCH_LIMIT,
  };
}

/**
 * Con los dos candados (ADR-0029 punto 3): sin `postLock`, una programada de un post queda en
 * `errors` con `SUBJECT_NOT_LISTING` y sigue programada.
 */
export type StartDueDeps = PortalCheckDeps &
  SubjectLocks & {
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
 * de avisos y de posts (F9-T07, ADR-0029 punto 4) cuya hora venció hace 12 h o menos
 * (`SCHEDULE_OVERDUE_MS`; las más atrasadas esperan al operador), de plataformas sin paso manual
 * (Marketplace es un recordatorio), por hora y como mucho 20. Cada una, dentro del candado de su
 * sujeto (`runOnSubject`: el del aviso o el del post), con las revisiones de publicarla
 * (`requireStartableOne`; un post no tiene las de Portal ni Marketplace):
 * - si sigue `scheduled` a esa hora y pasa la revisión de publicar (con el modo **de la
 *   publicación**, fijado al programar), `scheduled` → `publishing` (actor `system`) y se encola
 *   después del candado;
 * - si la revisión falla con un error no reintentable, `scheduled` → `failed` con el motivo;
 * - si otro cambio llegó antes, se salta.
 * Una que falla no corta las demás. Nada se lanza: el resultado dice qué pasó con cada una. Una
 * de un post con una cuenta en modo `manual` (ADR-0029 punto 9) sí se empieza: el intento no llama
 * a la red y la deja lista para publicar a mano (`awaiting_manual_confirm`), que es su recordatorio.
 */
export async function startDuePublications(deps: StartDueDeps): Promise<StartDueResult> {
  const now = (deps.now ?? (() => new Date()))();
  const due = await deps.publications.listDue(dueQuery(now));
  const result: StartDueResult = {
    started: [],
    notQueued: [],
    failed: [],
    skipped: [],
    errors: [],
  };
  for (const candidate of due) {
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
  const definitions = await subjectDefinitionsBeforeLock(
    deps,
    candidate.subject,
    candidate.platform,
  );
  return runOnSubject(deps, candidate.subject, async (locked) => {
    const publication = await locked.repos.publications.get(candidate.id);
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
      return locked.repos.publications.transition(
        publication.id,
        { from: "scheduled", to: "failed", changes: { lastError: lastErrorOf(error) } },
        {
          actor: "system",
          payload: { mode: publication.dryRun ? "dry-run" : "live", due: true, code: error.code },
        },
      );
    }
    return startOne(locked.repos.publications, publication, {
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
