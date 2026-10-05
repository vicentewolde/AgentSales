import type { Content } from "../content.js";
import { AppError } from "../errors.js";
import type { FieldDefinition } from "../field-definition.js";
import type { Listing } from "../listing.js";
import type { ContentRepository } from "../ports/content-repository.js";
import type { FieldDefinitionRepository } from "../ports/field-definition-repository.js";
import type { LockedRepositories } from "../ports/listing-lock.js";
import type { ListingRepository } from "../ports/listing-repository.js";
import type { ContentCheckContext } from "./check.js";
import { type CheckedContent, checked, loadCheckContext } from "./check-context.js";

/** Lo que se lee **antes** del candado: el texto, su aviso y las definiciones de campos. */
export type ContentLockDeps = {
  contents: Pick<ContentRepository, "get">;
  listings: Pick<ListingRepository, "get">;
  /** `LockedRepositories` no los trae (spec F3, T05): se leen fuera, antes de `run`. */
  fieldDefinitions: Pick<FieldDefinitionRepository, "list">;
};

export const contentNotFound = (contentId: string) =>
  new AppError("CONTENT_NOT_FOUND", `No existe el texto ${contentId}`, { details: { contentId } });

/**
 * Antes del candado: el aviso del texto y sus definiciones de campos (las pide la revisión
 * editorial). `CONTENT_NOT_FOUND` o `LISTING_NOT_FOUND` si falta alguno.
 */
export async function beforeContentLock(
  deps: ContentLockDeps,
  contentId: string,
): Promise<{ listingId: string; definitions: FieldDefinition[] }> {
  const content = await deps.contents.get(contentId);
  if (content === null) throw contentNotFound(contentId);
  const listing = await deps.listings.get(content.listingId);
  if (listing === null) {
    throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${content.listingId}`, {
      details: { listingId: content.listingId },
    });
  }
  const definitions = await deps.fieldDefinitions.list({
    category: listing.category,
    brokerId: listing.brokerId,
  });
  return { listingId: listing.id, definitions };
}

/**
 * Dentro del candado: el texto (que exista y sea el vigente de su canal), su aviso y el contexto de
 * su revisión, con los repositorios de la transacción y las definiciones leídas antes. Lo comparten
 * aprobar, quitar la aprobación y editar. `CONTENT_NOT_FOUND`, `CONTENT_NOT_CURRENT`,
 * `LISTING_NOT_FOUND` o `BROKER_NOT_FOUND`.
 */
export async function lockedCurrentContent(
  locked: LockedRepositories,
  contentId: string,
  definitions: readonly FieldDefinition[],
): Promise<{ content: Content; listing: Listing; ctx: ContentCheckContext }> {
  const content = await locked.contents.get(contentId);
  if (content === null) throw contentNotFound(contentId);
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
  const { listing, ctx } = await loadCheckContext(
    {
      listings: locked.listings,
      brokers: locked.brokers,
      fieldDefinitions: { list: async () => [...definitions] },
    },
    content.listingId,
  );
  return { content, listing, ctx };
}

export type { CheckedContent };
export { checked };
