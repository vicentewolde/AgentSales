import { type CheckedContent, checked, loadCheckContext } from "../content/check-context.js";
import { AppError } from "../errors.js";
import type { ContentRepository } from "../ports/content-repository.js";
import type { FieldDefinitionRepository } from "../ports/field-definition-repository.js";
import type { ListingLock } from "../ports/listing-lock.js";
import type { ListingRepository } from "../ports/listing-repository.js";
import type { Publication, PublicationActor } from "../publication.js";
import { canTransition } from "../publication-state.js";
import { lockedCurrentContent } from "./approve-content.js";

export type UnapproveContentDeps = {
  contents: Pick<ContentRepository, "get">;
  listings: Pick<ListingRepository, "get">;
  fieldDefinitions: Pick<FieldDefinitionRepository, "list">;
  lock: ListingLock;
};

export type UnapprovedContent = CheckedContent & { cancelled: Publication[] };

/**
 * Quita la aprobación del texto vigente de un canal ("rechazar" del roadmap; ADR-0014, spec F3
 * §4.2, `POST /contents/:id/unapprove`): el texto queda en `edited` (protege lo revisado de una
 * regeneración sin aviso) y se cancelan las publicaciones de ese texto que aún no salieron y se
 * pueden descartar (`approved`, `scheduled`, `failed`, `awaiting_manual_confirm`). Las publicadas
 * no cambian. Errores (`AppError`, 409 salvo el primero):
 * - el texto no existe → `CONTENT_NOT_FOUND` (404); no es el vigente → `CONTENT_NOT_CURRENT`;
 * - no está aprobado → `CONTENT_NOT_APPROVED`;
 * - una de sus publicaciones se está publicando → `PUBLICATION_IN_PROGRESS` (sin cambiar nada).
 */
export async function unapproveContent(
  deps: UnapproveContentDeps,
  { contentId, actor }: { contentId: string; actor: PublicationActor },
): Promise<UnapprovedContent> {
  const before = await deps.contents.get(contentId);
  if (before === null) {
    throw new AppError("CONTENT_NOT_FOUND", `No existe el texto ${contentId}`, {
      details: { contentId },
    });
  }
  const listingBefore = await deps.listings.get(before.listingId);
  const definitions =
    listingBefore === null
      ? []
      : await deps.fieldDefinitions.list({
          category: listingBefore.category,
          brokerId: listingBefore.brokerId,
        });

  return deps.lock.run(before.listingId, async (locked) => {
    const content = await lockedCurrentContent(locked, contentId);
    if (content.status !== "approved") {
      throw new AppError("CONTENT_NOT_APPROVED", "Ese texto no está aprobado", {
        details: { contentId, status: content.status },
      });
    }
    const own = (await locked.publications.listByListing(content.listingId)).filter(
      (publication) => publication.contentId === content.id,
    );
    const publishing = own.find((publication) => publication.status === "publishing");
    if (publishing !== undefined) {
      throw new AppError(
        "PUBLICATION_IN_PROGRESS",
        "Una publicación de este texto se está publicando: espera a que termine",
        { details: { contentId, publicationId: publishing.id } },
      );
    }
    const cancelled: Publication[] = [];
    for (const publication of own) {
      if (!canTransition(publication.status, "cancelled")) continue;
      cancelled.push(
        await locked.publications.transition(
          publication.id,
          { from: publication.status, to: "cancelled" },
          { actor, payload: { reason: "unapproved", contentId } },
        ),
      );
    }
    const edited = await locked.contents.update(content.id, { status: "edited" });
    const { ctx } = await loadCheckContext(
      {
        listings: locked.listings,
        brokers: locked.brokers,
        fieldDefinitions: { list: async () => definitions },
      },
      content.listingId,
    );
    return { ...checked(edited, ctx), cancelled };
  });
}
