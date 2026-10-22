import type { AbortSignalLike } from "../abort.js";
import type { ProcessedMediaVariant, VideoMediaVariant } from "../enums.js";
import type { MediaMeasurements } from "./media-repository.js";

/** Variantes de una foto (y el `thumb` de un video): todas menos las de video. */
export type ImageVariant = Exclude<ProcessedMediaVariant, VideoMediaVariant>;

/** Una variante de imagen producida (JPEG), con el sha256 de sus bytes (spec F2 §4.2). */
export type ImageOutput = {
  variant: ImageVariant;
  bytes: Uint8Array;
  width: number;
  height: number;
  mime: "image/jpeg";
  sha256: string;
};

/**
 * Un video producido (el reel, el video para X o el de Discord): queda en el temporal del intento y se sube con
 * `putStream` (`open()`), porque puede pesar hasta 300 MB. `size` en bytes.
 */
export type VideoOutput = {
  size: number;
  sha256: string;
  width: number;
  height: number;
  durationS: number;
  open(): AsyncIterable<Uint8Array>;
};

export type ProcessedImage = {
  /** Del original, ya rotado según su orientación. */
  measurements: MediaMeasurements;
  /** Una por variante pedida, en el mismo orden. */
  outputs: ImageOutput[];
};

export type ProcessedVideo = {
  measurements: MediaMeasurements;
  thumb: ImageOutput;
  /** `null` si no se pidió o si el video dura menos de `REEL_MIN_DURATION_S`. */
  reel: VideoOutput | null;
  /**
   * El video reducido para X (spec F9 §4.5, solo posts): `null` si no se pidió. Con la duración
   * completa del original: el límite de X es NO VERIFICADO y lo revisa quien publica (T16).
   */
  xVideo: VideoOutput | null;
  /**
   * El video liviano para Discord (spec F9.5 D8, solo posts): `null` si no se pidió o si no se puede
   * (con el tope, el bitrate quedaría bajo el mínimo legible, o el resultado igual no cupo). Pesa
   * menos de `maxBytes`, con la duración completa del original.
   */
  discordVideo: VideoOutput | null;
};

/**
 * Lo que se pide de un video además de sus medidas y su `thumb`:
 * - `reel`: el reel 9:16; `overlayPng` es el texto que va encima los primeros 2 s (el de un aviso)
 *   o `null` para un reel sin texto (un post, spec F9 §4.5);
 * - `xVideo`: el video reducido para X (por defecto, no);
 * - `discordVideo`: el video liviano para Discord bajo `maxBytes` (por defecto, no; core pide
 *   `DISCORD_VIDEO_MAX_BYTES`; el tope es un parámetro para probar con un video corto).
 */
export type VideoProcessOptions = {
  reel: { overlayPng: Uint8Array | null } | null;
  xVideo?: boolean;
  discordVideo?: { maxBytes: number } | null;
  /**
   * La música de fondo (F9.5-T19) de todo lo que se arme en esta pasada (el reel, el video para X y
   * el de Discord): con sonido propio, detrás de él; sin sonido, sola. Sin ella, como antes.
   */
  music?: MusicInput | null;
};

/**
 * Una pista de la biblioteca de música (F9.5-T19), ya leída de R2 (un MP3 de pocos MB). El
 * procesador la recorta a la duración del video (o la repite si es más corta), le pone un fundido
 * al final y, si el video trae sonido, la mezcla más baja detrás de él (`MUSIC_SPEC` de
 * `packages/media`).
 */
export type MusicInput = { bytes: Uint8Array };

/**
 * Una foto del reel armado con fotos (F9.5-T18): su tipo y cómo leer el original. El procesador
 * las lee de a una (`read`), así no tiene todos los originales en memoria a la vez.
 */
export type ReelPhotoInput = { mime: string; read: () => Promise<Uint8Array> };

/**
 * Lo que se pide del reel armado con fotos: `overlayPng` es el texto que va encima los primeros
 * 2 s, como en el reel de un video (o `null`, sin texto); `music`, la pista de fondo (F9.5-T19;
 * sin ella, una pista silenciosa).
 */
export type PhotoReelOptions = { overlayPng: Uint8Array | null; music?: MusicInput | null };

/**
 * Procesador de medios (spec F2 §4.2): el worker lo crea por intento, con el directorio temporal
 * de ese intento, que borra al terminar (el puerto no tiene `dispose`). Core solo ve bytes y
 * streams, nunca rutas. Errores (`AppError`):
 * - `MEDIA_DECODE_FAILED`: el archivo no se puede leer (advertencia de ese medio; la corrida sigue);
 * - `MEDIA_TOOL_NOT_INSTALLED`: falta ffmpeg o ffprobe, o es anterior a 8.1 (no reintentable, con
 *   el comando para instalarlo);
 * - `MEDIA_ABORTED` (reintentable): se cortó con `signal`; los procesos hijos terminan.
 *
 * El procesador no devuelve avisos: los de tamaño de una foto y de largo del reel los calcula core
 * desde las medidas guardadas (`photoSizeWarnings` y `reelWarnings`), en cada corrida.
 */
export interface MediaProcessor {
  /** Versión de los parámetros de las variantes: cambiarla las regenera (va en la clave de R2). */
  readonly version: string;
  processImage(
    input: Uint8Array,
    options: { mime: string; variants: readonly ImageVariant[] },
    signal?: AbortSignalLike,
  ): Promise<ProcessedImage>;
  /**
   * Medidas y `thumb` de un video; con `reel`, además el reel (con el PNG del texto encima durante
   * los primeros 2 s, si viene), cortado a `REEL_MAX_DURATION_S` (F2-T08); con `xVideo`, el video
   * reducido para X (F9-T10); con `discordVideo`, el video liviano para Discord (F9.5-T10).
   */
  processVideo(
    input: AsyncIterable<Uint8Array>,
    options: VideoProcessOptions,
    signal?: AbortSignalLike,
  ): Promise<ProcessedVideo>;
  /**
   * El reel de una propiedad sin video, armado con sus fotos en el orden recibido (F9.5-T18): cada
   * una unos segundos con un fundido entre ellas, la foto entera sobre su propia imagen desenfocada
   * y el texto encima los primeros 2 s. Pide entre `REEL_PHOTOS.min` y `REEL_PHOTOS.max` fotos
   * (otra cantidad es un bug de quien llama: `MEDIA_REEL_PHOTOS_INVALID`); una foto ilegible es
   * `MEDIA_DECODE_FAILED`.
   */
  processPhotoReel(
    photos: readonly ReelPhotoInput[],
    options: PhotoReelOptions,
    signal?: AbortSignalLike,
  ): Promise<VideoOutput>;
}
