import type { AbortSignalLike } from "../abort.js";
import { AppError } from "../errors.js";
import { REEL_MAX_DURATION_S, REEL_MIN_DURATION_S, REEL_PHOTOS } from "../media-checks.js";
import type {
  ImageOutput,
  ImageVariant,
  MediaProcessor,
  ProcessedImage,
  ProcessedVideo,
  VideoOutput,
} from "../ports/media-processor.js";
import type { MediaMeasurements } from "../ports/media-repository.js";
import { fakeHash } from "./fake-hash.js";

/** Una llamada recibida por el procesador falso (sin los bytes). */
export type MediaProcessorCall =
  | { kind: "image"; mime: string; variants: ImageVariant[]; inputBytes: number }
  | {
      kind: "video";
      reel: boolean;
      xVideo: boolean;
      /** El tope pedido para el video de Discord, o `null` si no se pidió. */
      discordMaxBytes: number | null;
      inputBytes: number;
      /** La música recibida (F9.5-T19), como texto, o `null` sin música. */
      music: string | null;
    }
  /**
   * El reel con fotos (F9.5-T18): cuántas fotos recibió, sus tipos, si llevaba texto y la música
   * (F9.5-T19, como texto, o `null`).
   */
  | { kind: "photoReel"; photos: number; mimes: string[]; overlay: boolean; music: string | null };

export type InMemoryMediaProcessorOptions = {
  version?: string;
  /** Medidas de cada entrada (por defecto, 2000×1500 en fotos y 1920×1080 de 30 s en videos). */
  measure?: (input: Uint8Array, kind: "image" | "video") => MediaMeasurements;
  /** El video de Discord no se puede (como el adaptador bajo el bitrate mínimo): `null`. */
  discordVideoFails?: boolean;
  /** La pasada del video de Discord falla con `MEDIA_DECODE_FAILED` (las demás no). */
  discordVideoThrows?: boolean;
  /** El reel con fotos falla con `MEDIA_DECODE_FAILED` (como si ffmpeg no pudiera armarlo). */
  photoReelThrows?: boolean;
  /**
   * ffmpeg no puede leer la pista (F9.5-T19): los videos salen sin música y con `withoutMusic`,
   * como el adaptador al rehacerlos sin ella.
   */
  musicFails?: boolean;
};

export type InMemoryMediaProcessor = MediaProcessor & { calls: MediaProcessorCall[] };

// Core no carga los tipos de Node ni del DOM (sin `TextEncoder`): los textos de prueba son ASCII.
const encoder = {
  encode: (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff),
};
const decoder = {
  decode: (bytes: Uint8Array) => Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
};

/** Una entrada que empieza con `CORRUPTO` no se puede leer (`MEDIA_DECODE_FAILED`). */
const isCorrupt = (input: Uint8Array) => decoder.decode(input.slice(0, 8)) === "CORRUPTO";

const decodeFailed = () => new AppError("MEDIA_DECODE_FAILED", "No se pudo leer el medio");

function output(variant: ImageVariant, source: Uint8Array, version: string): ImageOutput {
  const bytes = encoder.encode(`${variant}:v${version}:${decoder.decode(source)}`);
  const [width, height] =
    variant === "thumb" ? [800, 600] : variant === "ig_4x5" ? [1080, 1350] : [1600, 1200];
  return {
    variant,
    bytes,
    width,
    height,
    mime: "image/jpeg",
    sha256: fakeHash(decoder.decode(bytes)),
  };
}

function throwIfAborted(signal: AbortSignalLike | undefined) {
  if (signal?.aborted) {
    throw new AppError("MEDIA_ABORTED", "Se cortó el procesamiento de medios", { retriable: true });
  }
}

const video = (
  out: Uint8Array,
  size: { width: number; height: number; durationS: number },
  withoutMusic = false,
): VideoOutput => ({
  ...(withoutMusic ? { withoutMusic: true } : {}),
  ...size,
  size: out.length,
  sha256: fakeHash(decoder.decode(out)),
  async *open() {
    yield out;
  },
});

/** Lo que dura cada foto en el reel con fotos (como `PHOTO_REEL_SPEC` del adaptador). */
const PHOTO_REEL_SLIDE_S = 3;

/**
 * Procesador de medios para los tests de core: deriva salidas deterministas de los bytes de entrada
 * (el mismo original da el mismo sha256), registra las llamadas y simula un archivo ilegible
 * (`CORRUPTO…`) y el corte con `signal`. No es el adaptador de `packages/media`.
 */
export function createInMemoryMediaProcessor(
  options: InMemoryMediaProcessorOptions = {},
): InMemoryMediaProcessor {
  const version = options.version ?? "test-1";
  const calls: MediaProcessorCall[] = [];
  const measure =
    options.measure ??
    ((_: Uint8Array, kind: "image" | "video") =>
      kind === "image"
        ? { width: 2000, height: 1500, durationS: null }
        : { width: 1920, height: 1080, durationS: 30 });

  return {
    version,
    calls,
    async processImage(input, { mime, variants }, signal): Promise<ProcessedImage> {
      throwIfAborted(signal);
      calls.push({ kind: "image", mime, variants: [...variants], inputBytes: input.length });
      if (isCorrupt(input)) throw decodeFailed();
      return {
        measurements: measure(input, "image"),
        outputs: variants.map((variant) => output(variant, input, version)),
      };
    },
    async processVideo(
      input,
      { reel, xVideo = false, discordVideo = null, music = null },
      signal,
    ): Promise<ProcessedVideo> {
      throwIfAborted(signal);
      const chunks: Uint8Array[] = [];
      for await (const chunk of input) chunks.push(chunk);
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      calls.push({
        kind: "video",
        reel: reel !== null,
        xVideo,
        discordMaxBytes: discordVideo?.maxBytes ?? null,
        inputBytes: bytes.length,
        music: music === null ? null : decoder.decode(music.bytes),
      });
      // Con música, cada video la lleva (otro contenido, otro sha256); sin ella, como antes.
      const dropped = music !== null && options.musicFails === true;
      const withMusic = music === null || dropped ? "" : `:m=${decoder.decode(music.bytes)}`;
      if (isCorrupt(bytes)) throw decodeFailed();
      if (discordVideo !== null && options.discordVideoThrows === true) throw decodeFailed();
      const measurements = measure(bytes, "video");
      // Como el adaptador (F2-T08): menos de 3 s no da reel; más de 90 s se corta.
      const duration = measurements.durationS ?? 0;
      const reelBytes =
        reel === null || duration < REEL_MIN_DURATION_S
          ? null
          : encoder.encode(
              `reel:v${version}:${decoder.decode(bytes)}:${reel.overlayPng?.length ?? 0}${withMusic}`,
            );
      // El video para X: con la duración completa (sin el tope del reel), como el adaptador.
      const xBytes = xVideo
        ? encoder.encode(`x_video:v${version}:${decoder.decode(bytes)}${withMusic}`)
        : null;
      const discordBytes =
        discordVideo === null || options.discordVideoFails === true
          ? null
          : encoder.encode(`discord_video:v${version}:${decoder.decode(bytes)}${withMusic}`);
      return {
        measurements,
        thumb: output("thumb", bytes, version),
        reel:
          reelBytes === null
            ? null
            : video(
                reelBytes,
                {
                  width: 1080,
                  height: 1920,
                  durationS: Math.min(duration, REEL_MAX_DURATION_S),
                },
                dropped,
              ),
        xVideo:
          xBytes === null
            ? null
            : video(xBytes, { width: 1280, height: 720, durationS: duration }, dropped),
        discordVideo:
          discordBytes === null
            ? null
            : video(discordBytes, { width: 1280, height: 720, durationS: duration }, dropped),
      };
    },
    async processPhotoReel(photos, { overlayPng, music = null }, signal): Promise<VideoOutput> {
      throwIfAborted(signal);
      calls.push({
        kind: "photoReel",
        photos: photos.length,
        mimes: photos.map((photo) => photo.mime),
        overlay: overlayPng !== null,
        music: music === null ? null : decoder.decode(music.bytes),
      });
      if (photos.length < REEL_PHOTOS.min || photos.length > REEL_PHOTOS.max) {
        throw new AppError("MEDIA_REEL_PHOTOS_INVALID", "El reel con fotos pide entre 3 y 10");
      }
      // Se leen de a una, como el adaptador.
      const sources: string[] = [];
      for (const photo of photos) sources.push(decoder.decode(await photo.read()));
      if (
        options.photoReelThrows === true ||
        sources.some((source) => source.startsWith("CORRUPTO"))
      )
        throw decodeFailed();
      const dropped = music !== null && options.musicFails === true;
      const out = encoder.encode(
        `photo_reel:v${version}:${sources.join("|")}:${overlayPng?.length ?? 0}${music === null || dropped ? "" : `:m=${decoder.decode(music.bytes)}`}`,
      );
      return video(
        out,
        { width: 1080, height: 1920, durationS: photos.length * PHOTO_REEL_SLIDE_S },
        dropped,
      );
    },
  };
}
