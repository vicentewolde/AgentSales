import {
  beforeContentLock,
  type CheckedContent,
  type ContentLockDeps,
  lockedCurrentContent,
  settlePostStatus,
} from "../content/locked-content.js";
import { AppError } from "../errors.js";
import { manualConfirmPending } from "../marketplace/limits.js";
import type { Publication, PublicationActor } from "../publication.js";
import { canTransition } from "../publication-state.js";
import { runOnSubject, type SubjectLocks } from "../subject-lock.js";
import { channelPublications } from "./open-publications.js";

export type UnapproveContentDeps = ContentLockDeps & SubjectLocks;

export type UnapprovedContent = CheckedContent & {
  /** Las publicaciones de este texto que se descartaron. */
  cancelled: Publication[];
  /**
   * Todas las publicaciones del canal del aviso o del post (en un post, de todos sus idiomas),
   * después del cambio (leídas en el candado).
   */
  publications: Publication[];
};

/**
 * Quita la aprobación del texto vigente de un canal ("rechazar" del roadmap; ADR-0014, spec F3
 * §4.2, `POST /contents/:id/unapprove`): el texto queda en `edited` (protege lo revisado de una
 * regeneración sin aviso) y se cancelan las publicaciones de ese texto que aún no salieron y que la
 * máquina deja descartar (`approved`, `scheduled` y `failed`). Las publicadas no cambian. Una que
 * espera el clic final de Marketplace bloquea (`MANUAL_CONFIRM_PENDING`): primero el operador dice
 * si la publicó (spec F5 §4.3, D11). Corre en el candado de su sujeto, el del aviso o el del post
 * (ADR-0029); un post sin otro texto aprobado vuelve a `draft`. Todas las revisiones van antes de
 * la primera escritura. Errores (`AppError`, 409 salvo los "no existe"):
 * - el texto o su aviso o post no existen → `CONTENT_NOT_FOUND`, `LISTING_NOT_FOUND` o
 *   `POST_NOT_FOUND` (404);
 * - no es el vigente → `CONTENT_NOT_CURRENT`; no está aprobado → `CONTENT_NOT_APPROVED`;
 * - una de sus publicaciones se está publicando → `PUBLICATION_IN_PROGRESS` (sin cambiar nada).
 */
export async function unapproveContent(
  deps: UnapproveContentDeps,
  { contentId, actor }: { contentId: string; actor: PublicationActor },
): Promise<UnapprovedContent> {
  const { subject, definitions } = await beforeContentLock(deps, contentId);

  return runOnSubject(deps, subject, async (locked) => {
    const found = await lockedCurrentContent(locked, contentId, definitions);
    const { repos, content } = found;
    if (content.status !== "approved") {
      throw new AppError("CONTENT_NOT_APPROVED", "Ese texto no está aprobado", {
        details: { contentId, status: content.status },
      });
    }
    const own = (await repos.publications.listBySubject(content.subject)).filter(
      (publication) => publication.contentId === content.id,
    );
    const waiting = own.find((publication) => publication.status === "awaiting_manual_confirm");
    if (waiting !== undefined) throw manualConfirmPending(waiting.id);
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
        await repos.publications.transition(
          publication.id,
          { from: publication.status, to: "cancelled" },
          { actor, payload: { reason: "unapproved", contentId } },
        ),
      );
    }
    const edited = await repos.contents.update(content.id, { status: "edited" });
    if (found.kind === "post") await settlePostStatus(found.repos, found.post);
    return {
      ...found.review(edited),
      cancelled,
      publications: await channelPublications(repos, content.subject, content.platform),
    };
  });
}
