import { hasContentErrors } from "../content/check.js";
import {
  beforeContentLock,
  type CheckedContent,
  type ContentLockDeps,
  checked,
  lockedCurrentContent,
} from "../content/locked-content.js";
import { AppError } from "../errors.js";
import { LISTING_NOT_PREPARABLE_TEXT } from "../labels.js";
import { canPrepareContent } from "../listing.js";
import type { ListingLock } from "../ports/listing-lock.js";
import type { Publication, PublicationActor } from "../publication.js";
import {
  channelPublications,
  createPublications,
  planPublications,
  type SkippedPublication,
} from "./open-publications.js";

export type ApproveContentDeps = ContentLockDeps & { lock: ListingLock };

export type ApprovedContent = CheckedContent & {
  /** Las publicaciones que nacieron ahora. */
  created: Publication[];
  /** Formatos que no se abrieron porque ya tenían una publicación activa de otro texto. */
  skipped: SkippedPublication[];
  /** Todas las publicaciones del canal del aviso, después de aprobar (leídas en el candado). */
  publications: Publication[];
};

/**
 * Aprueba el texto **vigente** de un canal (ADR-0014, spec F3 §4.2, `POST /contents/:id/approve`):
 * lo deja en `approved` y, si el corredor tiene una cuenta conectada en ese canal, abre sus
 * publicaciones (Instagram: carrusel y, con video, reel), todo dentro del candado del aviso. Todas
 * las revisiones van antes de la primera escritura. Errores (`AppError`, 409 salvo los "no existe"):
 * - el texto o su aviso no existen → `CONTENT_NOT_FOUND` o `LISTING_NOT_FOUND` (404);
 * - no es el vigente → `CONTENT_NOT_CURRENT`;
 * - el aviso no está en `ready`, `active` o `paused` → `LISTING_NOT_READY`;
 * - hay una corrida activa (de textos o de imágenes, que reemplaza los medios) → `CONTENT_RUN_ACTIVE`;
 * - la revisión editorial tiene errores → `CONTENT_HAS_ERRORS` (las advertencias no bloquean);
 * - con una cuenta conectada, faltan las fotos del canal → `CONTENT_NOT_READY`.
 * Aprobar un texto ya aprobado vuelve a revisar y abre lo que falte (idempotente).
 */
export async function approveContent(
  deps: ApproveContentDeps,
  { contentId, actor }: { contentId: string; actor: PublicationActor },
): Promise<ApprovedContent> {
  const { listingId, definitions } = await beforeContentLock(deps, contentId);

  return deps.lock.run(listingId, async (locked) => {
    const { content, listing, ctx } = await lockedCurrentContent(locked, contentId, definitions);
    if (!canPrepareContent(listing.status)) {
      throw new AppError("LISTING_NOT_READY", LISTING_NOT_PREPARABLE_TEXT, {
        details: { listingId: listing.id, status: listing.status },
      });
    }
    const active = await locked.contentRuns.findActive(listing.id);
    if (active !== null) {
      throw new AppError(
        "CONTENT_RUN_ACTIVE",
        "Hay una preparación de contenido en curso: espera a que termine para aprobar",
        { details: { contentId, contentRunId: active.id } },
      );
    }
    const review = checked(content, ctx);
    if (hasContentErrors(review.checks)) {
      throw new AppError(
        "CONTENT_HAS_ERRORS",
        "La revisión encontró errores en el texto: corrígelos antes de aprobar",
        { details: { contentId, codes: review.checks.map((check) => check.code) } },
      );
    }
    const opening = await planPublications(locked, { listing, content });

    // Recién aquí se escribe: nada de lo anterior puede dejar el texto aprobado a medias.
    const approved =
      content.status === "approved"
        ? content
        : await locked.contents.update(content.id, { status: "approved" });
    const created = await createPublications(locked, {
      listing,
      content: approved,
      planned: opening.toCreate,
      actor,
    });
    return {
      content: approved,
      checks: review.checks,
      created,
      skipped: opening.skipped,
      publications: await channelPublications(locked, listing.id, approved.platform),
    };
  });
}
