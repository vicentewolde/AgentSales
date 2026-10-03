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
