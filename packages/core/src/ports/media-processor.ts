import type { AbortSignalLike } from "../abort.js";
import type { ProcessedMediaVariant } from "../enums.js";
import type { MediaMeasurements } from "./media-repository.js";

/** Variantes de una foto: todas menos el reel. */
export type ImageVariant = Exclude<ProcessedMediaVariant, "ig_reel">;

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
 * El reel producido: queda en el temporal del intento y se sube con `putStream` (`open()`), porque
 * puede pesar hasta 300 MB. `size` en bytes.
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
};

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
   * Medidas y `thumb` de un video; con `reel`, además el reel con el PNG del texto encima durante
   * los primeros 2 s, cortado a `REEL_MAX_DURATION_S` (F2-T08).
   */
  processVideo(
    input: AsyncIterable<Uint8Array>,
    options: { reel: { overlayPng: Uint8Array } | null },
    signal?: AbortSignalLike,
  ): Promise<ProcessedVideo>;
}
