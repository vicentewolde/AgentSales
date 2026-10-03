import { formatNumber } from "./price.js";

/**
 * Ancho mínimo de una foto para cada plataforma (spec F2 §4.2): Instagram publica a 1080 px de
 * ancho, y Mercado Libre (Portal Inmobiliario) recomendaría 1200 (por confirmar en F4). Una foto
 * más chica igual se usa: se amplía y se avisa.
 */
export const PHOTO_MIN_WIDTH = { instagram: 1080, portal: 1200 } as const;

export const PHOTO_SIZE_WARNING_CODES = [
  "IMAGE_SMALL_FOR_INSTAGRAM",
  "IMAGE_SMALL_FOR_PORTAL",
] as const;
export type PhotoSizeWarningCode = (typeof PHOTO_SIZE_WARNING_CODES)[number];

/** Textos fijos (van al reporte de la corrida, sin nombres de archivo ni datos del aviso). */
export const PHOTO_SIZE_WARNING_TEXT: Readonly<Record<PhotoSizeWarningCode, string>> = {
  IMAGE_SMALL_FOR_INSTAGRAM: `La foto mide menos de ${formatNumber(PHOTO_MIN_WIDTH.instagram)} px de ancho: se amplió para Instagram y puede verse borrosa`,
  IMAGE_SMALL_FOR_PORTAL: `La foto mide menos de ${formatNumber(PHOTO_MIN_WIDTH.portal)} px de ancho: Portal Inmobiliario recomienda fotos más grandes`,
};

/**
 * Advertencias de tamaño de una foto a partir de su ancho guardado (ya rotado). Las calcula core en
 * cada corrida (F2-T10), no el procesador: así se ven también cuando la foto ya estaba procesada.
 */
export function photoSizeWarnings(
  width: number | null,
): { code: PhotoSizeWarningCode; message: string }[] {
  if (width === null) return [];
  const codes: PhotoSizeWarningCode[] = [];
  if (width < PHOTO_MIN_WIDTH.instagram) codes.push("IMAGE_SMALL_FOR_INSTAGRAM");
  if (width < PHOTO_MIN_WIDTH.portal) codes.push("IMAGE_SMALL_FOR_PORTAL");
  return codes.map((code) => ({ code, message: PHOTO_SIZE_WARNING_TEXT[code] }));
}

/**
 * Largo del reel de Instagram (spec F2 §4.2): Meta acepta desde 3 s; el tope de 90 s es nuestro (Meta
 * acepta hasta 15 min). Los usan el procesador (que corta o no arma el reel) y la corrida (avisos).
 */
export const REEL_MIN_DURATION_S = 3;
export const REEL_MAX_DURATION_S = 90;

export const REEL_WARNING_CODES = ["VIDEO_TOO_SHORT", "VIDEO_TRIMMED"] as const;
export type ReelWarningCode = (typeof REEL_WARNING_CODES)[number];

export const REEL_WARNING_TEXT: Readonly<Record<ReelWarningCode, string>> = {
  VIDEO_TOO_SHORT: `El video dura menos de ${REEL_MIN_DURATION_S} s: Instagram no acepta reels tan cortos, así que no se armó`,
  VIDEO_TRIMMED: `El video dura más de ${REEL_MAX_DURATION_S} s: el reel se cortó en los primeros ${REEL_MAX_DURATION_S} s`,
};

/**
 * Avisos del reel a partir de la duración guardada del video. Los calcula core en cada corrida
 * (F2-T10), como los de tamaño de una foto: así se ven aunque el reel ya estuviera armado, y un video
 * de menos de 3 s no se vuelve a descargar solo para avisar.
 */
export function reelWarnings(
  durationS: number | null,
): { code: ReelWarningCode; message: string }[] {
  if (durationS === null) return [];
  const code: ReelWarningCode | null =
    durationS < REEL_MIN_DURATION_S
      ? "VIDEO_TOO_SHORT"
      : durationS > REEL_MAX_DURATION_S
        ? "VIDEO_TRIMMED"
        : null;
  return code === null ? [] : [{ code, message: REEL_WARNING_TEXT[code] }];
}
