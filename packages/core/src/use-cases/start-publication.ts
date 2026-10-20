import { AppError } from "../errors.js";
import { manualConfirmPending } from "../marketplace/limits.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import type { Publication, PublicationActor } from "../publication.js";
import { outcomeUnknownPending } from "../publish/outcome.js";
import { runOnSubject, type SubjectLocks } from "../subject-lock.js";
import {
  enqueuePublications,
  type MarketplaceStartOptions,
  type PortalCheckDeps,
  publicationNotFound,
  STARTABLE_STATUSES,
  startOne,
  subjectDefinitionsBeforeLock,
} from "./publication-start.js";
import { requireStartableOne } from "./start-checks.js";

/** `postLock` hace falta para una publicación de un post (sin él, `SUBJECT_NOT_LISTING`). */
export type StartPublicationDeps = PortalCheckDeps &
  SubjectLocks & {
    queue: JobQueue;
    /** Marketplace: el límite diario y si se puede convertir la UF (spec F5 §4.6 y §4.7). */
    marketplace?: MarketplaceStartOptions;
    now?: () => Date;
    /** Fuera del candado: solo para saber de qué sujeto es la publicación. */
    publications: Pick<PublicationRepository, "get">;
  };

export type StartPublicationResult = {
  publication: Publication;
  /** `true` si ya estaba en `publishing`: se reencoló sin cambiarla (conserva su modo). */
  requeued: boolean;
};

/**
 * Publica o reintenta **una** publicación (spec F3 §4.3, `POST /publications/:id/publish`):
 * - `approved`, `failed` o `scheduled` (adelantarla, F6) → `publishing`, con el modo de la API
 *   (`dryRun`) y su evento; un
 *   reintento desde `failed` conserva `progress` (para no publicar dos veces);
 * - ya en `publishing` → la reencola sin cambiarla ni revisarla (`requeued`): un corte en el
 *   último intento la dejaba sin job, y el intento (T11) revisa todo al correr;
 * y encola después del candado. Revisa lo mismo que publicar el canal, sobre su propio texto (el
 * fijado al nacer, que no cambia mientras está pendiente: ADR-0014). Errores (`AppError`):
 * - no existe → `PUBLICATION_NOT_FOUND` (404); el aviso no está en `ready` o `active` → `LISTING_NOT_READY`;
 *   el post no está en `draft` ni `ready` → `POST_NOT_READY` (F9-T07: dentro del candado del post);
 * - hay una corrida activa → `CONTENT_RUN_ACTIVE`; su texto ya no está aprobado → `CONTENT_NOT_APPROVED`;
 * - su cuenta ya no está conectada → `ACCOUNT_NOT_CONNECTED`;
 * - ya empezó en `live` y se pide en `dry-run` → `PUBLISH_MODE_LOCKED`;
 * - en Portal, el texto aprobado tiene errores según la revisión de hoy → `CONTENT_HAS_ERRORS`, o
 *   al aviso le falta lo que pide Portal → `PORTAL_NOT_READY` (spec F4 §4.5), o el aviso cambió
 *   desde que nació la publicación → `PUBLICATION_LISTING_CHANGED` (§4.6);
 * - en Marketplace, espera el clic final → `MANUAL_CONFIRM_PENDING`; le falta algo al aviso →
 *   `MARKETPLACE_NOT_READY`; otra de la cuenta tiene el formulario abierto → `MARKETPLACE_FORM_OPEN`;
 *   en `live`, la cuenta llegó a su límite del día → `MARKETPLACE_DAILY_LIMIT` (spec F5 §4.7);
 * - ya está publicada → `NOTHING_TO_PUBLISH`; descartada o retirada → `INVALID_TRANSITION`;
 * - la cola no está → `QUEUE_UNAVAILABLE` (503): queda en `publishing` y se reencola pidiéndolo otra vez.
 */
export async function startPublication(
  deps: StartPublicationDeps,
  {
    publicationId,
    dryRun,
    actor,
  }: { publicationId: string; dryRun: boolean; actor: PublicationActor },
): Promise<StartPublicationResult> {
  const found = await deps.publications.get(publicationId);
  if (found === null) throw publicationNotFound(publicationId);
  const definitions = await subjectDefinitionsBeforeLock(deps, found.subject, found.platform);

  const result = await runOnSubject(deps, found.subject, async (locked) => {
    const publication = await locked.repos.publications.get(publicationId);
    if (publication === null) throw publicationNotFound(publicationId);
    if (publication.status === "publishing") return { publication, requeued: true };
    // Marketplace: primero el operador dice si la publicó (spec F5 §4.3).
    if (publication.status === "awaiting_manual_confirm") throw manualConfirmPending(publicationId);
    // No se sabe si salió (ADR-0029 punto 8): reintentar podría publicarla dos veces.
    if (publication.status === "outcome_unknown") throw outcomeUnknownPending(publicationId);
    if (publication.status === "published") {
      throw new AppError("NOTHING_TO_PUBLISH", "Esta publicación ya está publicada", {
        details: { publicationId },
      });
    }
    if (!STARTABLE_STATUSES.includes(publication.status)) {
      throw new AppError(
        "INVALID_TRANSITION",
        "Esta publicación no se puede publicar: se descartó o se retiró",
        { details: { publicationId, from: publication.status, to: "publishing" } },
      );
    }
    await requireStartableOne(locked, publication, {
      dryRun,
      definitions,
      marketplace: deps.marketplace ?? {},
      now: (deps.now ?? (() => new Date()))(),
      manualLimits: true,
    });
    return {
      publication: await startOne(locked.repos.publications, publication, { dryRun, actor }),
      requeued: false,
    };
  });

  await enqueuePublications(deps.queue, [result.publication]);
  return result;
}
