import { canonicalJson } from "../canonical-json.js";
import type { ProcessedMediaVariant, RenderedMediaVariant } from "../enums.js";
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
  variant: Exclude<ProcessedMediaVariant, "ig_reel">,
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
