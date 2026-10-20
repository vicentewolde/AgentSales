import { AppError } from "../errors.js";
import { PLATFORM_TEXT } from "../labels.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import type { Publication, PublicationActor } from "../publication.js";
import { runOnSubject, type SubjectLocks } from "../subject-lock.js";
import { listingBackToReadyIfLast, OPERATION_PLATFORMS } from "./publication-operations.js";
import { publicationNotFound } from "./publication-start.js";

/** `postLock` hace falta para una publicación de un post (sin él, `SUBJECT_NOT_LISTING`). */
export type RetirePublicationDeps = SubjectLocks & {
  /** Fuera del candado: solo para saber de qué sujeto es la publicación. */
  publications: Pick<PublicationRepository, "get">;
};

export type RetiredPublication = {
  publication: Publication;
  /**
   * `true` si era la última publicada en `live` y el aviso volvió de `active` a `ready`. Siempre
   * `false` en un post: nunca pasa a `active` (ADR-0029 punto 4).
   */
  listingBackToReady: boolean;
};

/**
 * Marca como retirada una publicación (spec F3 §4.3 y D8, `POST /publications/:id/retire`):
 * `published` → `unpublished`, con su evento, dentro del candado de su sujeto (el del aviso o,
 * desde F9-T07, el del post). Con Instagram Login no
 * se puede borrar por la API, así que en `live` el operador confirma que la borró a mano
 * (`removedByHand`); en `dry-run` no hay nada que borrar. Si era la última publicada en `live` del
 * aviso, el aviso vuelve de `active` a `ready` (cambio del sistema, condicional: si el aviso ya
 * cambió, no se toca). Errores (`AppError`):
 * - no existe → `PUBLICATION_NOT_FOUND` (404);
 * - es de una plataforma que se cierra desde AgentSales (Portal) → `RETIRE_NOT_SUPPORTED` (409, spec
 *   F4 §4.9): se usa Cerrar;
 * - en `live` sin la confirmación → `REMOVAL_NOT_CONFIRMED` (409), sin cambiar nada;
 * - no está publicada → `INVALID_TRANSITION` (409).
 */
export async function retirePublication(
  deps: RetirePublicationDeps,
  {
    publicationId,
    actor,
    removedByHand = false,
  }: { publicationId: string; actor: PublicationActor; removedByHand?: boolean },
): Promise<RetiredPublication> {
  const found = await deps.publications.get(publicationId);
  if (found === null) throw publicationNotFound(publicationId);
  if (OPERATION_PLATFORMS.has(found.platform)) {
    throw new AppError(
      "RETIRE_NOT_SUPPORTED",
      "Esta publicación se cierra desde AgentSales: usa Cerrar en vez de marcarla como retirada",
      { details: { publicationId, platform: found.platform } },
    );
  }

  return runOnSubject(deps, found.subject, async (locked) => {
    const publication = await locked.repos.publications.get(publicationId);
    if (publication === null) throw publicationNotFound(publicationId);
    if (publication.status !== "published") {
      throw new AppError("INVALID_TRANSITION", "Solo se retira una publicación publicada", {
        details: { publicationId, from: publication.status, to: "unpublished" },
      });
    }
    const live = !publication.dryRun;
    if (live && !removedByHand) {
      throw new AppError(
        "REMOVAL_NOT_CONFIRMED",
        `Bórrala a mano en ${PLATFORM_TEXT[publication.platform]} y confirma que lo hiciste antes de marcarla como retirada`,
        { details: { publicationId } },
      );
    }
    const retired = await locked.repos.publications.transition(
      publicationId,
      { from: "published", to: "unpublished" },
      { actor, payload: { mode: live ? "live" : "dry-run", removedByHand: live } },
    );
    // Lo del aviso (volver de `active` a `ready`) no aplica a un post.
    const listingBackToReady =
      live && locked.kind === "listing"
        ? await listingBackToReadyIfLast(locked.repos, locked.subject.id)
        : false;
    return { publication: retired, listingBackToReady };
  });
}
