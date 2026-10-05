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

/** Un formato que no se abrió porque ya tenía una publicación activa **de otro texto** en esa cuenta. */
export type SkippedPublication = {
  platformAccountId: string;
  format: PublicationFormat;
  publicationId: string;
};

/** Una publicación por abrir: su cuenta, su formato y sus medios. */
export type PlannedPublication = PublicationPlanItem & { platformAccountId: string };

/** Lo que se va a abrir y lo que se salta, sin haber escrito nada. */
export type PublicationOpening = { toCreate: PlannedPublication[]; skipped: SkippedPublication[] };

/**
 * Planifica las publicaciones de un texto (ADR-0014, spec F3 §4.2), **sin escribir**: una por
 * cuenta conectada del corredor en el canal y por formato. Un formato que ya tiene una publicación
 * activa en esa cuenta no se abre: si es de este mismo texto, ya está (aprobar de nuevo es
 * idempotente); si es de otro (por ejemplo, una `published` de un texto anterior), se informa en
 * `skipped`. Sin cuentas conectadas no hay nada que abrir. Con cuentas, un `post` sin medios es
 * `CONTENT_NOT_READY` (también si todos los formatos se fueran a saltar: el plan se arma antes).
 * Se llama antes de cualquier escritura, así un rechazo no deja nada a medias (el candado en memoria
 * no deshace).
 */
export async function planPublications(
  repos: Pick<LockedRepositories, "platformAccounts" | "media" | "publications">,
  { listing, content }: { listing: Listing; content: Content },
): Promise<PublicationOpening> {
  const accounts = (
    await repos.platformAccounts.listByBroker(listing.brokerId, content.platform)
  ).filter((account) => account.status === "connected");
  if (accounts.length === 0) return { toCreate: [], skipped: [] };

  const plan = publicationPlan(content.platform, await repos.media.listByListing(listing.id));
  const active = (await repos.publications.listByListing(listing.id)).filter((publication) =>
    ACTIVE_PUBLICATION_STATUSES.includes(publication.status),
  );
  const toCreate: PlannedPublication[] = [];
  const skipped: SkippedPublication[] = [];
  for (const account of accounts) {
    for (const item of plan) {
      const existing = active.find(
        (publication) =>
          publication.platformAccountId === account.id && publication.format === item.format,
      );
      if (existing === undefined) {
        toCreate.push({ ...item, platformAccountId: account.id });
      } else if (existing.contentId !== content.id) {
        skipped.push({
          platformAccountId: account.id,
          format: item.format,
          publicationId: existing.id,
        });
      }
    }
  }
  return { toCreate, skipped };
}

/** Crea las publicaciones planificadas, en `approved`, con `content_id` y `media_ids` fijos. */
export async function createPublications(
  repos: Pick<LockedRepositories, "publications">,
  {
    listing,
    content,
    planned,
    actor,
  }: {
    listing: Listing;
    content: Content;
    planned: readonly PlannedPublication[];
    actor: PublicationActor;
  },
): Promise<Publication[]> {
  const created: Publication[] = [];
  for (const item of planned) {
    created.push(
      await repos.publications.create(
        {
          listingId: listing.id,
          platformAccountId: item.platformAccountId,
          platform: content.platform,
          format: item.format,
          contentId: content.id,
          mediaIds: item.mediaIds,
        },
        { actor, payload: { contentId: content.id, mediaCount: item.mediaIds.length } },
      ),
    );
  }
  return created;
}

/** Las publicaciones de un canal del aviso, para devolverlas leídas dentro del candado. */
export async function channelPublications(
  repos: Pick<LockedRepositories, "publications">,
  listingId: string,
  platform: Platform,
): Promise<Publication[]> {
  return (await repos.publications.listByListing(listingId)).filter(
    (publication) => publication.platform === platform,
  );
}
