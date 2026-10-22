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

const MIB = 1024 * 1024;

/**
 * Lo que acepta Discord por archivo adjunto de un webhook: 20 MiB desde el 2026-09-03 (DOC,
 * `docs/integraciones/discord.md` §5.2). Lo usan el publisher (qué se adjunta) y `post.media` (si
 * hace falta el video liviano).
 */
export const DISCORD_FILE_MAX_BYTES = 20 * MIB;

/**
 * El tope del video liviano para Discord (`discord_video`, spec F9.5 D8): 19 MiB, 1 MiB bajo el
 * límite por archivo para no rozarlo. `post.media` lo arma solo si el post va a Discord y el video
 * más liviano (`x_video` o `ig_reel`) pesa más de `DISCORD_FILE_MAX_BYTES`.
 */
export const DISCORD_VIDEO_MAX_BYTES = 19 * MIB;

/**
 * Cómo se reparte el tope del video para Discord (D8 de F9.5): AAC a `audioKbps` si hay audio, un
 * margen del contenedor (`containerOverhead`) y el video en la duración más el búfer del VBV
 * (`bufferS`), entre `minVideoKbps` (bajo eso se vería ilegible: no se arma) y `maxVideoKbps`. Los
 * usan el procesador (`DISCORD_VIDEO_SPEC` de `packages/media`) y `post.media`, que no lee el
 * original si ya sabe que no se puede.
 */
export const DISCORD_VIDEO_RATE = {
  audioKbps: 64,
  minVideoKbps: 500,
  maxVideoKbps: 5000,
  bufferS: 1,
  containerOverhead: 0.03,
} as const;

/**
 * El bitrate del video para Discord (kbps) que deja el archivo bajo `maxBytes` según su duración
 * (`DISCORD_VIDEO_RATE`): el presupuesto menos el margen del contenedor y el audio, repartido en la
 * duración más el búfer, hasta `maxVideoKbps`. `null` si queda bajo `minVideoKbps`.
 */
export function discordVideoBitrateKbps({
  durationS,
  hasAudio,
  maxBytes,
}: {
  durationS: number;
  hasAudio: boolean;
  maxBytes: number;
}): number | null {
  const { audioKbps, bufferS, containerOverhead, minVideoKbps, maxVideoKbps } = DISCORD_VIDEO_RATE;
  if (!(durationS > 0) || !(maxBytes > 0)) return null;
  const budgetKbits = (maxBytes * 8 * (1 - containerOverhead)) / 1000;
  const audioKbits = hasAudio ? audioKbps * durationS : 0;
  const kbps = Math.floor((budgetKbits - audioKbits) / (durationS + bufferS));
  if (kbps < minVideoKbps) return null;
  return Math.min(kbps, maxVideoKbps);
}
