import {
  beforeContentLock,
  type CheckedContent,
  type ContentLockDeps,
  checked,
  lockedCurrentContent,
} from "../content/locked-content.js";
import { AppError } from "../errors.js";
import type { ListingLock } from "../ports/listing-lock.js";
import type { Publication, PublicationActor } from "../publication.js";
import { canTransition } from "../publication-state.js";
import { channelPublications } from "./open-publications.js";

export type UnapproveContentDeps = ContentLockDeps & { lock: ListingLock };

export type UnapprovedContent = CheckedContent & {
  /** Las publicaciones de este texto que se descartaron. */
  cancelled: Publication[];
  /** Todas las publicaciones del canal del aviso, después del cambio (leídas en el candado). */
  publications: Publication[];
};

/**
 * Quita la aprobación del texto vigente de un canal ("rechazar" del roadmap; ADR-0014, spec F3
 * §4.2, `POST /contents/:id/unapprove`): el texto queda en `edited` (protege lo revisado de una
 * regeneración sin aviso) y se cancelan las publicaciones de ese texto que aún no salieron y que la
 * máquina deja descartar (`approved`, `scheduled`, `failed` y `awaiting_manual_confirm`). Las
 * publicadas no cambian. Todas las revisiones van antes de la primera escritura. Errores
 * (`AppError`, 409 salvo los "no existe"):
 * - el texto o su aviso no existen → `CONTENT_NOT_FOUND` o `LISTING_NOT_FOUND` (404);
 * - no es el vigente → `CONTENT_NOT_CURRENT`; no está aprobado → `CONTENT_NOT_APPROVED`;
 * - una de sus publicaciones se está publicando → `PUBLICATION_IN_PROGRESS` (sin cambiar nada).
 */
export async function unapproveContent(
  deps: UnapproveContentDeps,
  { contentId, actor }: { contentId: string; actor: PublicationActor },
): Promise<UnapprovedContent> {
  const { listingId, definitions } = await beforeContentLock(deps, contentId);

  return deps.lock.run(listingId, async (locked) => {
    const { content, ctx } = await lockedCurrentContent(locked, contentId, definitions);
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

    // Recién aquí se escribe.
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
    return {
      ...checked(edited, ctx),
      cancelled,
      publications: await channelPublications(locked, content.listingId, content.platform),
    };
  });
}
