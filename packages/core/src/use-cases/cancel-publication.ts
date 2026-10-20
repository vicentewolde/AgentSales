import { AppError } from "../errors.js";
import { manualConfirmPending } from "../marketplace/limits.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import type { Publication, PublicationActor } from "../publication.js";
import { canTransition } from "../publication-state.js";
import { outcomeUnknownPending } from "../publish/outcome.js";
import { runOnSubject, type SubjectLocks } from "../subject-lock.js";
import { publicationNotFound } from "./publication-start.js";

/** `postLock` hace falta para una publicación de un post (sin él, `SUBJECT_NOT_LISTING`). */
export type CancelPublicationDeps = SubjectLocks & {
  /** Fuera del candado: solo para saber de qué sujeto es la publicación. */
  publications: Pick<PublicationRepository, "get">;
};

/**
 * Descarta una publicación que no salió (spec F3 §4.3, `POST /publications/:id/cancel`):
 * `approved`, `scheduled` o `failed` → `cancelled`, con su evento, dentro del candado de su sujeto
 * (el del aviso o, desde F9-T07, el del post). El texto sigue aprobado: publicar de nuevo abre
 * otra. `publishing` → `cancelled` no existe a propósito: el candado de `saveProgress` depende de
 * eso. Errores (`AppError`):
 * - espera el clic final de Marketplace → `MANUAL_CONFIRM_PENDING` (409): la máquina deja
 *   descartarla, pero primero el operador dice si la publicó (spec F5 §4.3, D11);
 * - no se sabe si salió (`outcome_unknown`, ADR-0029 punto 8) → `OUTCOME_UNKNOWN_PENDING` (409):
 *   primero el operador la resuelve (`resolvePublication`);
 * - no existe → `PUBLICATION_NOT_FOUND` (404);
 * - se está publicando → `PUBLICATION_IN_PROGRESS` (409: espera a que termine);
 * - ya publicada, descartada o retirada → `INVALID_TRANSITION` (409; una publicada se retira).
 */
export async function cancelPublication(
  deps: CancelPublicationDeps,
  { publicationId, actor }: { publicationId: string; actor: PublicationActor },
): Promise<Publication> {
  const found = await deps.publications.get(publicationId);
  if (found === null) throw publicationNotFound(publicationId);

  return runOnSubject(deps, found.subject, async ({ repos: locked }) => {
    const publication = await locked.publications.get(publicationId);
    if (publication === null) throw publicationNotFound(publicationId);
    // El sistema nunca da por no publicado lo que no vio (spec F5 §4.3, D11).
    if (publication.status === "awaiting_manual_confirm")
      throw manualConfirmPending(publicationId, publication.platform);
    // Tampoco lo que pudo haber salido (ADR-0029 punto 8): primero dice si salió o no.
    if (publication.status === "outcome_unknown") throw outcomeUnknownPending(publicationId);
    if (publication.status === "publishing") {
      throw new AppError(
        "PUBLICATION_IN_PROGRESS",
        "La publicación se está publicando: espera a que termine para descartarla",
        { details: { publicationId } },
      );
    }
    if (!canTransition(publication.status, "cancelled")) {
      throw new AppError(
        "INVALID_TRANSITION",
        publication.status === "published"
          ? "La publicación ya salió: márcala como retirada en vez de descartarla"
          : "La publicación ya se descartó o se retiró",
        { details: { publicationId, from: publication.status, to: "cancelled" } },
      );
    }
    return locked.publications.transition(
      publicationId,
      { from: publication.status, to: "cancelled" },
      { actor, payload: { reason: "cancelled" } },
    );
  });
}
