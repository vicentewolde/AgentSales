import { instagramCaption } from "../content/assemble.js";
import type { Content } from "../content.js";
import { AppError } from "../errors.js";
import type { Media } from "../media.js";
import type { MediaStorage } from "../ports/media-storage.js";
import type {
  Publisher,
  PublishInput,
  PublishIssue,
  PublishMediaItem,
} from "../ports/publisher.js";
import type { Publication } from "../publication.js";

/** Vigencia de las URLs firmadas de un intento (spec F3 §4.4): 1 hora, recién creadas. */
export const PUBLISH_MEDIA_URL_TTL_S = 3600;

/**
 * Arma lo que se publica en un intento (spec F3 §4.4): el caption del texto aprobado (en
 * Instagram, `instagramCaption`) y los medios de `media_ids`, en su orden, con URLs firmadas
 * nuevas. `media` son los medios del aviso (`MediaRepository.listByListing`).
 * - `PUBLICATION_CONTENT_MISMATCH` si el texto no es el de la publicación;
 * - `PUBLICATION_MEDIA_MISSING` si falta un medio fijado (no debería pasar: no se reemplazan
 *   mientras la publicación está pendiente, ADR-0014).
 * Los dos son no reintentables. Un error de R2 al firmar pasa tal cual.
 */
export async function buildPublishInput(
  deps: { storage: Pick<MediaStorage, "signedReadUrl"> },
  {
    publication,
    content,
    media,
  }: { publication: Publication; content: Content; media: readonly Media[] },
): Promise<PublishInput> {
  if (content.id !== publication.contentId) {
    throw new AppError(
      "PUBLICATION_CONTENT_MISMATCH",
      "El texto no es el aprobado para esta publicación",
      { details: { publicationId: publication.id, contentId: content.id } },
    );
  }
  const items = publication.mediaIds.map((mediaId) => {
    const item = media.find((m) => m.id === mediaId && m.listingId === publication.listingId);
    if (item === undefined) {
      throw new AppError(
        "PUBLICATION_MEDIA_MISSING",
        "Falta un medio de la publicación: descártala y aprueba el texto de nuevo",
        { details: { publicationId: publication.id, mediaId } },
      );
    }
    return item;
  });
  const signed = await Promise.all(
    items.map(
      async (item): Promise<PublishMediaItem> => ({
        mediaId: item.id,
        kind: item.kind,
        mime: item.mime,
        storagePath: item.storagePath,
        url: await deps.storage.signedReadUrl(item.storagePath, PUBLISH_MEDIA_URL_TTL_S),
        bytes: item.bytes,
        width: item.width,
        height: item.height,
        durationS: item.durationS,
      }),
    ),
  );
  return {
    publicationId: publication.id,
    platform: publication.platform,
    format: publication.format,
    title: content.title,
    caption: publication.platform === "instagram" ? instagramCaption(content) : content.body,
    media: signed,
  };
}

/**
 * Los motivos por los que `publisher` no aceptaría `input`: primero la plataforma y el formato
 * (lo que core sabe), después los requisitos de la plataforma (`publisher.validate`).
 */
function publishIssues(publisher: Publisher, input: PublishInput): PublishIssue[] {
  if (input.platform !== publisher.platform) {
    return [
      {
        code: "PLATFORM_MISMATCH",
        message: "La publicación es de otra plataforma que la de este publicador",
      },
    ];
  }
  if (!publisher.formats.includes(input.format)) {
    return [{ code: "FORMAT_NOT_SUPPORTED", message: "La plataforma no publica este formato" }];
  }
  const validation = publisher.validate(input);
  return validation.ok ? [] : validation.issues;
}

/**
 * Revisa `input` antes de publicarlo, en `live` o en `dry-run` (`withDryRun`).
 * `PUBLISH_INPUT_INVALID` (no reintentable: los mismos datos fallarían igual) con los motivos en
 * el mensaje y en `details.issues`.
 */
export function checkPublishInput(publisher: Publisher, input: PublishInput): void {
  const issues = publishIssues(publisher, input);
  if (issues.length > 0) {
    throw new AppError(
      "PUBLISH_INPUT_INVALID",
      `La publicación no cumple los requisitos de la plataforma: ${issues
        .map((issue) => issue.message)
        .join("; ")}`,
      { details: { publicationId: input.publicationId, issues } },
    );
  }
}
