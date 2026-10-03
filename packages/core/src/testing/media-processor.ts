import type { AbortSignalLike } from "../abort.js";
import { AppError } from "../errors.js";
import { REEL_MAX_DURATION_S, REEL_MIN_DURATION_S } from "../media-checks.js";
import type {
  ImageOutput,
  ImageVariant,
  MediaProcessor,
  ProcessedImage,
  ProcessedVideo,
} from "../ports/media-processor.js";
import type { MediaMeasurements } from "../ports/media-repository.js";
import { fakeHash } from "./fake-hash.js";

/** Una llamada recibida por el procesador falso (sin los bytes). */
export type MediaProcessorCall =
  | { kind: "image"; mime: string; variants: ImageVariant[]; inputBytes: number }
  | { kind: "video"; reel: boolean; inputBytes: number };

export type InMemoryMediaProcessorOptions = {
  version?: string;
  /** Medidas de cada entrada (por defecto, 2000×1500 en fotos y 1920×1080 de 30 s en videos). */
  measure?: (input: Uint8Array, kind: "image" | "video") => MediaMeasurements;
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
    async processVideo(input, { reel }, signal): Promise<ProcessedVideo> {
      throwIfAborted(signal);
      const chunks: Uint8Array[] = [];
      for await (const chunk of input) chunks.push(chunk);
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      calls.push({ kind: "video", reel: reel !== null, inputBytes: bytes.length });
      if (isCorrupt(bytes)) throw decodeFailed();
      const measurements = measure(bytes, "video");
      // Como el adaptador (F2-T08): menos de 3 s no da reel; más de 90 s se corta.
      const duration = measurements.durationS ?? 0;
      const reelBytes =
        reel === null || duration < REEL_MIN_DURATION_S
          ? null
          : encoder.encode(`reel:v${version}:${decoder.decode(bytes)}:${reel.overlayPng.length}`);
      return {
        measurements,
        thumb: output("thumb", bytes, version),
        reel:
          reelBytes === null
            ? null
            : {
                size: reelBytes.length,
                sha256: fakeHash(decoder.decode(reelBytes)),
                width: 1080,
                height: 1920,
                durationS: Math.min(duration, REEL_MAX_DURATION_S),
                async *open() {
                  yield reelBytes;
                },
              },
      };
    },
  };
}
