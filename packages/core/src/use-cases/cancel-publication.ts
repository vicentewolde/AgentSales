import { AppError } from "../errors.js";
import type { ListingLock } from "../ports/listing-lock.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import type { Publication, PublicationActor } from "../publication.js";
import { canTransition } from "../publication-state.js";
import { publicationNotFound } from "./publication-start.js";

export type CancelPublicationDeps = {
  lock: ListingLock;
  /** Fuera del candado: solo para saber de qué aviso es la publicación. */
  publications: Pick<PublicationRepository, "get">;
};

/**
 * Descarta una publicación que no salió (spec F3 §4.3, `POST /publications/:id/cancel`):
 * `approved` o `failed` → `cancelled`, con su evento, dentro del candado del aviso (también
 * `scheduled` y `awaiting_manual_confirm`, que la máquina deja descartar, como al quitar la
 * aprobación; en F3 no se alcanzan, y la de Marketplace se revisa en F5). El texto sigue aprobado:
 * publicar de nuevo abre otra. Errores (`AppError`):
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

  return deps.lock.run(found.listingId, async (locked) => {
    const publication = await locked.publications.get(publicationId);
    if (publication === null) throw publicationNotFound(publicationId);
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
