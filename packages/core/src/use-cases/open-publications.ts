import { composeCarousel, composePhotoSet, composeReel } from "../content/compose.js";
import type { Content } from "../content.js";
import type { Platform, PublicationFormat } from "../enums.js";
import { AppError } from "../errors.js";
import type { Listing } from "../listing.js";
import type { Media } from "../media.js";
import type { LockedRepositories } from "../ports/listing-lock.js";
import type { Publication, PublicationActor } from "../publication.js";
import { ACTIVE_PUBLICATION_STATUSES } from "../publication-state.js";

/** Lo que se publica de un canal: un formato con sus medios, en orden. */
export type PublicationPlanItem = { format: PublicationFormat; mediaIds: string[] };

/**
 * Los formatos de un canal y sus medios (ADR-0014): Instagram da `post` (el carrusel: portada,
 * fotos y ficha) y, si el aviso tiene reel, `reel`; Portal y Marketplace dan `post` con las fotos
 * 4:3. Un `post` sin medios es `CONTENT_NOT_READY`: falta preparar las fotos.
 */
export function publicationPlan(
  platform: Platform,
  media: readonly Media[],
): PublicationPlanItem[] {
  const post = platform === "instagram" ? composeCarousel(media) : composePhotoSet(media);
  if (post.length === 0) {
    throw new AppError(
      "CONTENT_NOT_READY",
      "Faltan las fotos procesadas: prepara el contenido antes de aprobar",
      { details: { platform } },
    );
  }
  const plan: PublicationPlanItem[] = [{ format: "post", mediaIds: post.map((item) => item.id) }];
  const reel = platform === "instagram" ? composeReel(media) : null;
  if (reel !== null) plan.push({ format: "reel", mediaIds: [reel.id] });
  return plan;
}

/** Un formato que no se abrió porque ya tenía una publicación activa en esa cuenta. */
export type SkippedPublication = {
  platformAccountId: string;
  format: PublicationFormat;
  publicationId: string;
};

export type OpenedPublications = { created: Publication[]; skipped: SkippedPublication[] };

/**
 * Abre las publicaciones de un texto aprobado (ADR-0014, spec F3 §4.2): una por cuenta conectada
 * del corredor en ese canal y por formato, con `content_id` y `media_ids` fijos. Un formato que ya
 * tiene una publicación activa en esa cuenta (por ejemplo, una `published` de un texto anterior) se
 * salta y se informa, sin chocar con el único dentro del candado. Sin cuentas conectadas no abre
 * nada. Corre dentro de `ListingLock` (recibe sus repositorios); quien la llama ya revisó que el
 * texto esté aprobado y sea el vigente.
 */
export async function openPublications(
  repos: Pick<LockedRepositories, "platformAccounts" | "media" | "publications">,
  { listing, content, actor }: { listing: Listing; content: Content; actor: PublicationActor },
): Promise<OpenedPublications> {
  const accounts = (
    await repos.platformAccounts.listByBroker(listing.brokerId, content.platform)
  ).filter((account) => account.status === "connected");
  if (accounts.length === 0) return { created: [], skipped: [] };

  const plan = publicationPlan(content.platform, await repos.media.listByListing(listing.id));
  const active = (await repos.publications.listByListing(listing.id)).filter((publication) =>
    ACTIVE_PUBLICATION_STATUSES.includes(publication.status),
  );
  const created: Publication[] = [];
  const skipped: SkippedPublication[] = [];
  for (const account of accounts) {
    for (const item of plan) {
      const existing = active.find(
        (publication) =>
          publication.platformAccountId === account.id && publication.format === item.format,
      );
      if (existing !== undefined) {
        skipped.push({
          platformAccountId: account.id,
          format: item.format,
          publicationId: existing.id,
        });
        continue;
      }
      created.push(
        await repos.publications.create(
          {
            listingId: listing.id,
            platformAccountId: account.id,
            platform: content.platform,
            format: item.format,
            contentId: content.id,
            mediaIds: item.mediaIds,
          },
          { actor, payload: { contentId: content.id, mediaCount: item.mediaIds.length } },
        ),
      );
    }
  }
  return { created, skipped };
}
