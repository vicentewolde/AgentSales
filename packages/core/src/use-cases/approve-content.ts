import { hasContentErrors } from "../content/check.js";
import { type CheckedContent, checked, loadCheckContext } from "../content/check-context.js";
import type { Content } from "../content.js";
import { AppError } from "../errors.js";
import { LISTING_NOT_PREPARABLE_TEXT } from "../labels.js";
import { canPrepareContent } from "../listing.js";
import type { ContentRepository } from "../ports/content-repository.js";
import type { FieldDefinitionRepository } from "../ports/field-definition-repository.js";
import type { ListingLock, LockedRepositories } from "../ports/listing-lock.js";
import type { ListingRepository } from "../ports/listing-repository.js";
import type { PublicationActor } from "../publication.js";
import { type OpenedPublications, openPublications } from "./open-publications.js";

export type ApproveContentDeps = {
  contents: Pick<ContentRepository, "get">;
  listings: Pick<ListingRepository, "get">;
  /** Se leen antes del candado: `LockedRepositories` no los trae (spec F3, T05). */
  fieldDefinitions: Pick<FieldDefinitionRepository, "list">;
  lock: ListingLock;
};

export type ApprovedContent = CheckedContent & OpenedPublications;

const notFound = (contentId: string) =>
  new AppError("CONTENT_NOT_FOUND", `No existe el texto ${contentId}`, { details: { contentId } });

/**
 * El texto y su aviso, revisados dentro del candado: que exista, sea el vigente de su canal y el
 * aviso pueda tener contenido. Lo comparten aprobar y quitar la aprobación.
 */
export async function lockedCurrentContent(
  locked: LockedRepositories,
  contentId: string,
): Promise<Content> {
  const content = await locked.contents.get(contentId);
  if (content === null) throw notFound(contentId);
  const current = (await locked.contents.listCurrent(content.listingId)).find(
    (item) => item.platform === content.platform,
  );
  if (current?.id !== content.id) {
    throw new AppError(
      "CONTENT_NOT_CURRENT",
      "Ese texto ya no es el vigente: vuelve a cargar el contenido del aviso",
      { details: { contentId, currentId: current?.id ?? null } },
    );
  }
  return content;
}

/**
 * Aprueba el texto **vigente** de un canal (ADR-0014, spec F3 §4.2, `POST /contents/:id/approve`):
 * lo deja en `approved` y, si el corredor tiene una cuenta conectada en ese canal, abre sus
 * publicaciones (Instagram: carrusel y, con video, reel), todo dentro del candado del aviso.
 * Errores (`AppError`, 409 salvo el primero):
 * - el texto no existe → `CONTENT_NOT_FOUND` (404);
 * - no es el vigente → `CONTENT_NOT_CURRENT`;
 * - el aviso no está en `ready`, `active` o `paused` → `LISTING_NOT_READY`;
 * - hay una corrida activa (de textos o de imágenes, que reemplaza los medios) → `CONTENT_RUN_ACTIVE`;
 * - la revisión editorial tiene errores → `CONTENT_HAS_ERRORS` (las advertencias no bloquean);
 * - faltan las fotos del canal → `CONTENT_NOT_READY` (solo si hay una cuenta conectada).
 * Aprobar un texto ya aprobado vuelve a revisar y abre lo que falte (idempotente).
 */
export async function approveContent(
  deps: ApproveContentDeps,
  { contentId, actor }: { contentId: string; actor: PublicationActor },
): Promise<ApprovedContent> {
  // Fuera del candado, lo que `LockedRepositories` no trae: las definiciones de campos del aviso.
  const before = await deps.contents.get(contentId);
  if (before === null) throw notFound(contentId);
  const listingBefore = await deps.listings.get(before.listingId);
  if (listingBefore === null) {
    throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${before.listingId}`, {
      details: { listingId: before.listingId },
    });
  }
  const definitions = await deps.fieldDefinitions.list({
    category: listingBefore.category,
    brokerId: listingBefore.brokerId,
  });

  return deps.lock.run(before.listingId, async (locked) => {
    const content = await lockedCurrentContent(locked, contentId);
    const { listing, ctx } = await loadCheckContext(
      {
        listings: locked.listings,
        brokers: locked.brokers,
        fieldDefinitions: { list: async () => definitions },
      },
      content.listingId,
    );
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
    const approved =
      content.status === "approved"
        ? content
        : await locked.contents.update(content.id, { status: "approved" });
    const opened = await openPublications(locked, { listing, content: approved, actor });
    return { content: approved, checks: review.checks, ...opened };
  });
}
