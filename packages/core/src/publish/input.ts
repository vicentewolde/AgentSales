import { instagramCaption } from "../content/assemble.js";
import type { Content } from "../content.js";
import type { Platform } from "../enums.js";
import { AppError } from "../errors.js";
import type { Listing } from "../listing.js";
import type { Media } from "../media.js";
import type { PlatformAccount } from "../platform-account.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { ListingRepository } from "../ports/listing-repository.js";
import type { MediaStorage } from "../ports/media-storage.js";
import type {
  PublishBrokerContact,
  Publisher,
  PublishInput,
  PublishIssue,
  PublishListing,
  PublishMediaItem,
} from "../ports/publisher.js";
import type { Publication, PublishAttemptRecord } from "../publication.js";

/** Vigencia de las URLs firmadas de un intento (spec F3 §4.4): 1 hora, recién creadas. */
export const PUBLISH_MEDIA_URL_TTL_S = 3600;

/**
 * Las plataformas cuyo input lleva el aviso y el contacto del corredor, no solo el texto (spec F4
 * §4.6): en ellas lo aprobado incluye los datos del aviso (`listing_source_hash`). Instagram no.
 */
export const PUBLISH_LISTING_PLATFORMS: ReadonlySet<Platform> = new Set([
  "portal_inmobiliario",
  "fb_marketplace",
]);

export type PublishInputDeps = {
  storage: Pick<MediaStorage, "signedReadUrl">;
  listings: Pick<ListingRepository, "get" | "getSourceHash">;
  brokers: Pick<BrokerRepository, "findById">;
};

/** El aviso cambió (o la publicación no tiene versión): no se publica lo que no se aprobó. */
const listingChanged = (publicationId: string, reason: "changed" | "missing_version") =>
  new AppError(
    "PUBLICATION_LISTING_CHANGED",
    "El aviso cambió desde que se aprobó el texto (por ejemplo, una carga del Excel): descarta la publicación y aprueba de nuevo",
    { details: { publicationId, reason } },
  );

/**
 * Los datos del aviso que van en el input: nunca `internal_notes` ni `attributes._extra` (columnas
 * desconocidas del Excel, que tampoco ve la IA: pueden traer datos privados como la comisión).
 */
function publishListing(listing: Listing): PublishListing {
  const { _extra: _unknownColumns, ...attributes } = listing.attributes;
  return {
    id: listing.id,
    externalRef: listing.externalRef,
    operation: listing.operation,
    propertyType: listing.propertyType,
    region: listing.region,
    comuna: listing.comuna,
    address: listing.address,
    unitNumber: listing.unitNumber,
    showExactAddress: listing.showExactAddress,
    priceAmount: listing.priceAmount,
    priceCurrency: listing.priceCurrency,
    attributes,
  };
}

/**
 * El aviso y el contacto del corredor de una publicación de Portal o Marketplace (spec F4 §4.6):
 * la versión del aviso tiene que ser la de cuando nació la publicación (`listing_source_hash`); si
 * cambió o la publicación no la tiene, `PUBLICATION_LISTING_CHANGED` (no reintentable).
 */
async function listingPart(
  deps: Pick<PublishInputDeps, "listings" | "brokers">,
  publication: Publication,
): Promise<{ listing: PublishListing; brokerContact: PublishBrokerContact }> {
  if (publication.listingSourceHash === null) {
    throw listingChanged(publication.id, "missing_version");
  }
  // Primero el aviso y después su versión: una carga del Excel que se cruce entre las dos lecturas
  // cambia la versión y corta aquí, en vez de colar datos nuevos con la versión vieja.
  const listing = await deps.listings.get(publication.listingId);
  const current =
    listing === null ? null : await deps.listings.getSourceHash(publication.listingId);
  if (listing === null || current !== publication.listingSourceHash) {
    throw listingChanged(publication.id, "changed");
  }
  const broker = await deps.brokers.findById(listing.brokerId);
  if (broker === null) {
    throw new AppError("BROKER_NOT_FOUND", "No existe el corredor del aviso", {
      details: { publicationId: publication.id, brokerId: listing.brokerId },
    });
  }
  return {
    listing: publishListing(listing),
    brokerContact: { name: broker.name, email: broker.email, whatsapp: broker.whatsapp },
  };
}

/**
 * Arma lo que se publica en un intento (spec F3 §4.4): el caption del texto aprobado (en
 * Instagram, `instagramCaption`, sin título) y los medios de `media_ids`, en su orden, con URLs
 * firmadas nuevas. `media` son los medios del aviso (`MediaRepository.listByListing`). Antes de
 * firmar nada:
 * - `PUBLICATION_CONTENT_MISMATCH` si el texto no es el de la publicación (otro id o canal);
 * - `CONTENT_NOT_APPROVED` si el texto ya no está aprobado (no debería pasar: no se edita ni se
 *   desaprueba con la publicación en curso, ADR-0014);
 * - `PUBLICATION_MEDIA_MISSING` si falta un medio fijado (tampoco: no se reemplazan mientras la
 *   publicación está pendiente);
 * - en Portal y Marketplace (`PUBLISH_LISTING_PLATFORMS`), `PUBLICATION_LISTING_CHANGED` si el aviso
 *   cambió desde que nació la publicación o ella no tiene versión (spec F4 §4.6), y si no, suma el
 *   aviso (sin `internal_notes`) y el contacto del corredor.
 * Todos son no reintentables. Un error de R2 o de la base pasa tal cual.
 */
export async function buildPublishInput(
  deps: PublishInputDeps,
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
  const listingData = PUBLISH_LISTING_PLATFORMS.has(publication.platform)
    ? await listingPart(deps, publication)
    : null;
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
    ...(listingData ?? {}),
  };
}

/**
 * El WhatsApp para la bitácora, con los dígitos del medio ocultos: `+56 9 ****5678` (un celular
 * chileno) o `****5678`; con menos de 8 dígitos, todo oculto (`****`). `null` si no hay.
 */
export function maskWhatsapp(whatsapp: string | null): string | null {
  if (whatsapp === null) return null;
  const digits = whatsapp.replace(/\D/g, "");
  if (digits.length < 8) return "****";
  const last = digits.slice(-4);
  if (digits.length === 11 && digits.startsWith("569")) return `+56 9 ****${last}`;
  return `****${last}`;
}

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
    // Portal y Marketplace: el aviso enviado (sin la dirección ni la unidad si no se muestran) y
    // el contacto, con el WhatsApp enmascarado.
    ...(input.listing === undefined
      ? {}
      : {
          listing: input.listing.showExactAddress
            ? input.listing
            : { ...input.listing, address: null, unitNumber: null },
        }),
    ...(input.brokerContact === undefined
      ? {}
      : {
          brokerContact: {
            ...input.brokerContact,
            whatsapp: maskWhatsapp(input.brokerContact.whatsapp),
          },
        }),
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
  if (issues.length > 0) throw publishInputInvalid(input.publicationId, issues);
}

/**
 * `PUBLISH_INPUT_INVALID` (no reintentable) con los motivos en el mensaje y en `details.issues`: lo
 * usan `checkPublishInput` y `withDryRun` (el rechazo de `preflight`). Un rechazo sin motivos sigue
 * siendo un rechazo.
 */
export function publishInputInvalid(publicationId: string, issues: readonly PublishIssue[]) {
  const reasons =
    issues.length > 0
      ? [...issues]
      : [{ code: "INPUT_REJECTED", message: "La plataforma rechazó la publicación" }];
  return new AppError(
    "PUBLISH_INPUT_INVALID",
    `La publicación no cumple los requisitos de la plataforma: ${reasons
      .map((issue) => issue.message)
      .join("; ")}`,
    { details: { publicationId, issues: reasons } },
  );
}
