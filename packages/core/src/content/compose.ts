import type { Media } from "../media.js";
import { REEL_PHOTOS } from "../media-checks.js";

/** El máximo de elementos de un carrusel de Instagram (límite de la API). */
export const CAROUSEL_MAX_ITEMS = 10;
/** El mínimo de elementos de un carrusel de Instagram: con uno solo es una imagen suelta. */
export const CAROUSEL_MIN_ITEMS = 2;

const byOrder = (a: Media, b: Media) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1);

/** Las fotos originales del aviso, en su orden. */
const photosOf = (media: readonly Media[]) =>
  media.filter((item) => item.role === "original" && item.kind === "image").sort(byOrder);

/** Los videos originales del aviso, en su orden. */
export const videosOf = (media: readonly Media[]) =>
  media.filter((item) => item.role === "original" && item.kind === "video").sort(byOrder);

/** La foto de portada: la marcada (`foto_portada`) o, si no hay, la primera (spec F2, D3). */
export function coverPhoto(media: readonly Media[]): Media | null {
  const photos = photosOf(media);
  return photos.find((photo) => photo.isCover) ?? photos[0] ?? null;
}

/** La variante vigente `variant` de un original. */
export function variantOf(
  media: readonly Media[],
  parentId: string,
  variant: Media["variant"],
): Media | null {
  return (
    media.find(
      (item) =>
        item.role === "processed" && item.parentMediaId === parentId && item.variant === variant,
    ) ?? null
  );
}

const renderOf = (media: readonly Media[], variant: "cover" | "spec_sheet") =>
  media.find((item) => item.role === "rendered" && item.variant === variant) ?? null;

/**
 * El carrusel de Instagram (spec F2 §4.2): la portada (render), las fotos `ig_4x5` en el orden del
 * aviso sin la de portada (que ya está en el render) y al final la ficha (render), hasta 10. Lo que
 * falta (una foto que no se pudo procesar, un render que no existe) no va.
 */
export function composeCarousel(media: readonly Media[]): Media[] {
  const cover = renderOf(media, "cover");
  const sheet = renderOf(media, "spec_sheet");
  const coverOriginal = coverPhoto(media);
  const room = CAROUSEL_MAX_ITEMS - (cover === null ? 0 : 1) - (sheet === null ? 0 : 1);
  const photos = photosOf(media)
    .filter((photo) => cover === null || photo.id !== coverOriginal?.id)
    .map((photo) => variantOf(media, photo.id, "ig_4x5"))
    .filter((variant): variant is Media => variant !== null)
    .slice(0, room);
  return [...(cover === null ? [] : [cover]), ...photos, ...(sheet === null ? [] : [sheet])];
}

/** Las fotos de Portal Inmobiliario y Marketplace: `pi_4x3`, la portada primero y luego el orden. */
export function composePhotoSet(media: readonly Media[]): Media[] {
  const cover = coverPhoto(media);
  const photos = photosOf(media);
  const ordered = cover === null ? photos : [cover, ...photos.filter((p) => p.id !== cover.id)];
  return ordered
    .map((photo) => variantOf(media, photo.id, "pi_4x3"))
    .filter((variant): variant is Media => variant !== null);
}

/**
 * Las fotos del reel con fotos (F9.5-T18): las originales que se procesaron (tienen su `ig_4x5`),
 * la portada primero y luego en el orden del aviso, hasta `REEL_PHOTOS.max`. Con menos de
 * `REEL_PHOTOS.min`, vacío: no alcanzan para un reel.
 */
export function reelPhotos(media: readonly Media[]): Media[] {
  const cover = coverPhoto(media);
  const photos = photosOf(media);
  const ordered = cover === null ? photos : [cover, ...photos.filter((p) => p.id !== cover.id)];
  const ready = ordered
    .filter((photo) => variantOf(media, photo.id, "ig_4x5") !== null)
    .slice(0, REEL_PHOTOS.max);
  return ready.length < REEL_PHOTOS.min ? [] : ready;
}

/**
 * El reel vigente: el `ig_reel` del primer video del aviso; sin video, el armado con sus fotos
 * (F9.5-T18), que cuelga de la primera foto del reel (`reelPhotos`). `null` si no hay.
 */
export function composeReel(media: readonly Media[]): Media | null {
  const first = videosOf(media)[0] ?? reelPhotos(media)[0];
  return first === undefined ? null : variantOf(media, first.id, "ig_reel");
}

/** Si el reel salió de las fotos (F9.5-T18): cuelga de una foto, no de un video. */
export function isPhotoReel(media: readonly Media[], reel: Media): boolean {
  return media.some(
    (item) => item.id === reel.parentMediaId && item.role === "original" && item.kind === "image",
  );
}
