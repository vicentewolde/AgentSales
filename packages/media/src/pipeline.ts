import { type ImageVariant, REEL_MAX_DURATION_S, REEL_MIN_DURATION_S } from "@agentsales/core";

/**
 * Versión de los parámetros de las variantes y del reel (spec F2 §4.2). Va en la clave de R2 de
 * cada derivado (`…-v{version}.jpg`) y en la del reel: cambiar algo de `IMAGE_VARIANT_SPECS`, de
 * `REEL_SPEC` o de `X_VIDEO_SPEC` (un tamaño, una calidad, el recorte, el segundo del `thumb`)
 * **sube la versión**, y la siguiente corrida regenera todo (fotos incluidas) y borra lo anterior.
 * Si no se sube, lo ya procesado queda como estaba. Agregar una variante nueva sin tocar las
 * existentes (el reel sin texto y `x_video` de F9-T10) no la sube.
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

/**
 * El reel de Instagram (spec F2 §4.2, D5): 1080×1920 a 30 fps, H.264 4:2:0 con GOP cerrado de 2 s y
 * AAC estéreo, `moov` al inicio y sin edit lists. Bajo 25 Mbps (Meta) y bajo 300 MB en 90 s (tope
 * de 20 Mbps). Un video que no es vertical va al centro sobre su propia imagen desenfocada; el
 * desenfoque se hace en chico (270×480) y se amplía: mismo efecto, cuatro veces menos trabajo.
 */
export const REEL_SPEC = {
  width: 1080,
  height: 1920,
  fps: 30,
  /** Meta acepta de 3 s a 15 min; el tope de 90 s es nuestro (constantes de core). */
  minDurationS: REEL_MIN_DURATION_S,
  maxDurationS: REEL_MAX_DURATION_S,
  /** El texto del reel (PNG transparente de 1080×1920) va encima los primeros segundos. */
  overlayS: 2,
  blur: { width: 270, height: 480, radius: 8 },
  x264: { preset: "veryfast", crf: 23, maxrate: "20M", bufsize: "40M", gop: 60 },
  audio: { bitrate: "128k", sampleRate: 48000 },
  /** Segundo del video del que sale su `thumb` (o la mitad, si dura menos de 2 s). */
  thumbAtS: 1,
} as const;

/**
 * El video reducido para X (spec F9 §4.5, F9-T10; `docs/integraciones/x.md` §5.3). La guía de X
 * fija entre 32×32 y 1280×1024 y recomienda 1280×720, 720×1280 o 720×720, así que su máximo parece
 * aplicarse al lado largo en cualquier orientación: **NO VERIFICADO** hasta subir uno de verdad
 * (prueba de la sección 8 de la nota). Por eso cabe en 1280×720 (horizontal), 720×1280 (vertical)
 * o 720×720 (cuadrado), sin ampliar un video más chico, sin recorte ni barras. H.264 High 4:2:0 a
 * 30 fps con GOP cerrado de 2 s (X pide progresivo y sin GOP abierto), AAC estéreo si el original
 * tiene audio, `moov` al inicio. El tope de duración es el nuestro, el mismo del reel (X admite
 * 20 min en una cuenta normal).
 */
export const X_VIDEO_SPEC = {
  longSide: 1280,
  shortSide: 720,
  fps: 30,
  maxDurationS: REEL_MAX_DURATION_S,
  x264: { preset: "veryfast", crf: 23, maxrate: "8M", bufsize: "16M", gop: 60 },
  audio: { bitrate: "128k", sampleRate: 48000 },
} as const;
