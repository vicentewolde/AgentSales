import type { ImageVariant } from "@agentsales/core";

/**
 * Versión de los parámetros de las variantes (spec F2 §4.2). Va en la clave de R2 de cada derivado
 * (`…-v{version}.jpg`): cambiar un tamaño, una calidad o el recorte sube la versión, y la siguiente
 * corrida regenera las variantes y borra las anteriores.
 */
export const MEDIA_PIPELINE_VERSION = "1";

export type ImageVariantSpec =
  /** Sin recorte: el lado mayor hasta `maxSide`, sin ampliar. */
  | { fit: "inside"; maxSide: number; quality: number }
  /** Recorte centrado a `width`×`height`; una foto más chica se amplía. */
  | { fit: "cover"; width: number; height: number; quality: number };

/** Tamaños y calidades (JPEG) de cada variante de una foto (spec F2 §4.2). */
export const IMAGE_VARIANT_SPECS: Readonly<Record<ImageVariant, ImageVariantSpec>> = {
  // Para el panel (los navegadores no muestran HEIC).
  thumb: { fit: "inside", maxSide: 800, quality: 80 },
  // Instagram: JPEG sRGB de hasta 8 MB, entre 320 y 1440 px de ancho, 4:5.
  ig_4x5: { fit: "cover", width: 1080, height: 1350, quality: 90 },
  // Portal Inmobiliario y Marketplace: 4:3 (Mercado Libre aceptaría hasta 1920; por confirmar en F4).
  pi_4x3: { fit: "cover", width: 1600, height: 1200, quality: 88 },
};
