import { canonicalJson } from "../canonical-json.js";
import type { RenderedMediaVariant, VideoMediaVariant } from "../enums.js";
import type { ImageVariant } from "../ports/media-processor.js";
import {
  type CoverData,
  type ReelOverlayData,
  type SlideImageRef,
  type SpecSheetData,
  slideKeyInput,
} from "../ports/slide-templates.js";

// Claves de R2 de los derivados (spec F2 §4.2): determinísticas, para que un reintento sobrescriba
// lo mismo y para saber qué está vigente comparando `storagePath`. Una sola fuente para la etapa
// `media`, los renders, el reel y sus tests.

const listingRoot = (brokerId: string, listingId: string) =>
  `brokers/${brokerId}/listings/${listingId}`;

/** Una variante JPEG de un original (`thumb`, `ig_4x5`, `pi_4x3`; el `thumb` de un video también). */
export function variantPath(
  ids: { brokerId: string; listingId: string },
  variant: ImageVariant,
  originalSha256: string,
  processorVersion: string,
): string {
  return `${listingRoot(ids.brokerId, ids.listingId)}/processed/${variant}/${originalSha256}-v${processorVersion}.jpg`;
}

/** El reel: el video y un hash de su texto (si cambia el precio, cambia la clave). */
export function reelPath(
  ids: { brokerId: string; listingId: string },
  videoSha256: string,
  textSha256: string,
): string {
  return `${listingRoot(ids.brokerId, ids.listingId)}/processed/ig_reel/${videoSha256}-${textSha256}.mp4`;
}

/**
 * El reel armado con las fotos (F9.5-T18): el hash de sus fotos en orden (`photoReelInput`) y el
 * de su texto. `photos-` lo distingue del reel de un video.
 */
export function photoReelPath(
  ids: { brokerId: string; listingId: string },
  photosSha256: string,
  textSha256: string,
): string {
  return `${listingRoot(ids.brokerId, ids.listingId)}/processed/ig_reel/photos-${photosSha256}-${textSha256}.mp4`;
}

/**
 * Las fotos de un reel con fotos como texto: que sale de fotos y el sha256 de cada original en el
 * orden del reel. Su sha256 va en la clave: otra foto, otro orden u otra portada lo rehacen.
 */
export function photoReelInput(photoSha256s: readonly string[]): string {
  return canonicalJson({ source: "photos", photos: photoSha256s });
}

/** Un render (portada o ficha), por el hash de su entrada. */
export function renderPath(
  ids: { brokerId: string; listingId: string },
  variant: RenderedMediaVariant,
  inputSha256: string,
): string {
  return `${listingRoot(ids.brokerId, ids.listingId)}/rendered/${variant}/${inputSha256}.jpg`;
}

/**
 * La entrada de un render como texto: sus datos (las imágenes solo por su sha256) y la versión de
 * las plantillas. Su sha256 va en la clave: si algo cambia, el render se rehace.
 */
export function renderInput(
  data: CoverData<SlideImageRef> | SpecSheetData<SlideImageRef>,
  templatesVersion: string,
): string {
  return canonicalJson({ templates: templatesVersion, data: slideKeyInput(data) });
}

/** El texto del reel, con las versiones de las plantillas y del procesador. */
export function reelTextInput(
  data: ReelOverlayData,
  versions: { templates: string; processor: string },
): string {
  return canonicalJson({ ...versions, data: slideKeyInput(data) });
}

// ── Posts (spec F9 §4.5, F9-T10) ─────────────────────────────────────────────
// Todo lo de un post vive bajo `posts/{postId}/`: los originales que sube el panel o la CLI
// (ADR-0025) y sus variantes. Un post no tiene renders ni texto en el reel.

/** El prefijo de todos los objetos de un post. */
export const postObjectsPrefix = (postId: string) => `posts/${postId}/`;

/** Prefijo de los originales de un post (lo que `…/uploads/complete` revisa con `list`). */
export const postOriginalsPrefix = (postId: string) => `${postObjectsPrefix(postId)}original/`;

/**
 * Un original de un post, por su sha256 (como los de un aviso): determinística, así el mismo
 * archivo pedido dos veces es la misma subida y la misma clave.
 */
export function postOriginalPath(postId: string, sha256: string, extension: string): string {
  return `${postOriginalsPrefix(postId)}${sha256}.${extension}`;
}

/** Una variante JPEG de un original de un post (`thumb`, `ig_4x5`; el `thumb` de un video). */
export function postVariantPath(
  postId: string,
  variant: ImageVariant,
  originalSha256: string,
  processorVersion: string,
): string {
  return `${postObjectsPrefix(postId)}processed/${variant}/${originalSha256}-v${processorVersion}.jpg`;
}

/**
 * Un video derivado de un original de un post: el reel (sin texto encima) o el video para X. Lleva
 * la versión del procesador, como las variantes JPEG: cambiarla los regenera.
 */
export function postVideoPath(
  postId: string,
  variant: VideoMediaVariant,
  originalSha256: string,
  processorVersion: string,
): string {
  return `${postObjectsPrefix(postId)}processed/${variant}/${originalSha256}-v${processorVersion}.mp4`;
}
