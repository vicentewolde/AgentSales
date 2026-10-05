import { instagramCaption } from "../content/assemble.js";
import type { Content } from "../content.js";
import type { MediaKind, Platform, PublicationFormat } from "../enums.js";
import { AppError } from "../errors.js";
import type { Media } from "../media.js";
import type { PlatformAccount } from "../platform-account.js";
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
 * Instagram, `instagramCaption`, sin título) y los medios de `media_ids`, en su orden, con URLs
 * firmadas nuevas. `media` son los medios del aviso (`MediaRepository.listByListing`). Antes de
 * firmar nada:
 * - `PUBLICATION_CONTENT_MISMATCH` si el texto no es el de la publicación (otro id o canal);
 * - `CONTENT_NOT_APPROVED` si el texto ya no está aprobado (no debería pasar: no se edita ni se
 *   desaprueba con la publicación en curso, ADR-0014);
 * - `PUBLICATION_MEDIA_MISSING` si falta un medio fijado (tampoco: no se reemplazan mientras la
 *   publicación está pendiente).
 * Los tres son no reintentables. Un error de R2 al firmar pasa tal cual.
 */
export async function buildPublishInput(
  deps: { storage: Pick<MediaStorage, "signedReadUrl"> },
  {
    publication,
    content,
    media,
  }: { publication: Publication; content: Content; media: readonly Media[] },
): Promise<PublishInput> {
  if (content.id !== publication.contentId || content.platform !== publication.platform) {
    throw new AppError(
      "PUBLICATION_CONTENT_MISMATCH",
      "El texto no es el aprobado para esta publicación",
      { details: { publicationId: publication.id, contentId: content.id } },
    );
  }
  if (content.status !== "approved") {
    throw new AppError(
      "CONTENT_NOT_APPROVED",
      "El texto de la publicación ya no está aprobado: apruébalo de nuevo",
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
    ...(publication.platform === "instagram"
      ? { title: null, caption: instagramCaption(content) }
      : { title: content.title, caption: content.body }),
    media: signed,
  };
}

/**
 * Lo que se envió en un intento, o lo que se habría enviado en `dry-run` (spec F3 §4.3): formato,
 * título, caption completo, medios (rutas de R2, tipo, tamaño y medidas) y la cuenta. Va en el
 * evento `publish_attempt` de **cada** intento: después de publicada, una corrida nueva puede
 * reemplazar los medios, y la bitácora es lo que queda (ADR-0014). Nunca va al log (el caption
 * trae datos del aviso) y **nunca** lleva URLs firmadas ni credenciales.
 */
export type PublishAttemptRecord = {
  platform: Platform;
  format: PublicationFormat;
  title: string | null;
  caption: string;
  media: {
    mediaId: string;
    storagePath: string;
    kind: MediaKind;
    mime: string;
    bytes: number;
    width: number | null;
    height: number | null;
    durationS: number | null;
  }[];
  account: { id: string; displayName: string };
};

/** Arma el registro de un intento campo por campo (no copia el `PublishInput`, que trae URLs). */
export function publishAttemptRecord(
  input: PublishInput,
  account: Pick<PlatformAccount, "id" | "displayName">,
): PublishAttemptRecord {
  return {
    platform: input.platform,
    format: input.format,
    title: input.title,
    caption: input.caption,
    media: input.media.map((item) => ({
      mediaId: item.mediaId,
      storagePath: item.storagePath,
      kind: item.kind,
      mime: item.mime,
      bytes: item.bytes,
      width: item.width,
      height: item.height,
      durationS: item.durationS,
    })),
    account: { id: account.id, displayName: account.displayName },
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
  if (validation.ok) return [];
  // Un rechazo sin motivos sigue siendo un rechazo.
  return validation.issues.length > 0
    ? validation.issues
    : [{ code: "INPUT_REJECTED", message: "La plataforma rechazó la publicación" }];
}

/**
 * Revisa `input` antes de publicarlo: en `live` la llama el intento (T11) antes de `publish`, y en
 * `dry-run`, `withDryRun`.
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
