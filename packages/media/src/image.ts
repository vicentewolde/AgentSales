import { createHash, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AbortSignalLike,
  AppError,
  type ImageOutput,
  type ImageVariant,
  MEDIA_WARNING_TEXT,
  type MediaWarning,
  type MediaWarningCode,
  type ProcessedImage,
} from "@agentsales/core";
import sharp, { type OutputInfo } from "sharp";
import { IMAGE_VARIANT_SPECS, MIN_WIDTH } from "./pipeline.js";
import { CommandFailedError, runTool, throwIfAborted } from "./run.js";

/** HEIF y HEIC (fotos del iPhone): sharp no los decodifica, ffmpeg sí (`heic-conversion.md`). */
const HEIF_MIMES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

export type ImageToolOptions = {
  ffmpegPath: string;
  /** Directorio temporal del intento: aquí va la copia del HEIC que lee ffmpeg. */
  workDir: string;
  /** Revisa una vez que ffmpeg sea 8.1 o más nuevo (`MEDIA_TOOL_NOT_INSTALLED` si no). */
  ensureFfmpeg: (signal?: AbortSignalLike) => Promise<void>;
};

const decodeFailed = (cause?: unknown) =>
  new AppError(
    "MEDIA_DECODE_FAILED",
    "No se pudo leer la foto (formato no válido o archivo dañado)",
    {
      cause,
    },
  );

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Un HEIC a JPEG con ffmpeg: arma los mosaicos y aplica el giro guardado (`irot`). Calidad alta
 * (`-q:v 2`), porque sharp lo vuelve a comprimir después. ffmpeg lee de un archivo (el formato
 * necesita moverse por él) y escribe a su salida estándar.
 */
async function heicToJpeg(
  input: Uint8Array,
  options: ImageToolOptions,
  signal?: AbortSignalLike,
): Promise<Buffer> {
  await options.ensureFfmpeg(signal);
  const path = join(options.workDir, `${randomUUID()}.heic`);
  await writeFile(path, input);
  try {
    const args = [
      ...["-hide_banner", "-loglevel", "error", "-nostdin", "-i", path],
      ...["-frames:v", "1", "-map_metadata", "-1", "-q:v", "2"],
      ...["-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"],
    ];
    return await runTool(options.ffmpegPath, args, signal);
  } catch (error) {
    throw error instanceof CommandFailedError ? decodeFailed(error) : error;
  } finally {
    await rm(path, { force: true });
  }
}

/**
 * Una foto (JPEG, PNG, WebP o HEIC) → sus medidas y las variantes pedidas (spec F2 §4.2): rotadas
 * según su orientación, en sRGB, **sin metadatos** (EXIF, GPS, XMP: sharp no los copia si no se
 * le pide) y en JPEG, con el sha256 de cada salida.
 */
export async function processImage(
  input: Uint8Array,
  { mime, variants }: { mime: string; variants: readonly ImageVariant[] },
  options: ImageToolOptions,
  signal?: AbortSignalLike,
): Promise<ProcessedImage> {
  throwIfAborted(signal);
  const source = HEIF_MIMES.has(mime.toLowerCase())
    ? await heicToJpeg(input, options, signal)
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);

  let width: number | undefined;
  let height: number | undefined;
  try {
    const metadata = await sharp(source).metadata();
    // `autoOrient`: las medidas ya giradas según el EXIF (una foto vertical del celular).
    ({ width, height } = metadata.autoOrient ?? metadata);
  } catch (error) {
    throw decodeFailed(error);
  }
  if (!width || !height) throw decodeFailed();

  const outputs: ImageOutput[] = [];
  for (const variant of variants) {
    throwIfAborted(signal);
    const spec = IMAGE_VARIANT_SPECS[variant];
    const pipeline = sharp(source).rotate().toColourspace("srgb");
    const resized =
      spec.fit === "inside"
        ? pipeline.resize(spec.maxSide, spec.maxSide, { fit: "inside", withoutEnlargement: true })
        : pipeline.resize(spec.width, spec.height, { fit: "cover", position: "centre" });
    let result: { data: Buffer; info: OutputInfo };
    try {
      result = await resized.jpeg({ quality: spec.quality }).toBuffer({ resolveWithObject: true });
    } catch (error) {
      throw decodeFailed(error);
    }
    const bytes = new Uint8Array(
      result.data.buffer,
      result.data.byteOffset,
      result.data.byteLength,
    );
    outputs.push({
      variant,
      bytes,
      width: result.info.width,
      height: result.info.height,
      mime: "image/jpeg",
      sha256: sha256(bytes),
    });
  }

  const warnings: MediaWarning[] = [];
  const warn = (code: MediaWarningCode) =>
    warnings.push({ code, message: MEDIA_WARNING_TEXT[code] });
  if (variants.includes("ig_4x5") && width < MIN_WIDTH.instagram) warn("IMAGE_SMALL_FOR_INSTAGRAM");
  if (variants.includes("pi_4x3") && width < MIN_WIDTH.portal) warn("IMAGE_SMALL_FOR_PORTAL");

  return { measurements: { width, height, durationS: null }, outputs, warnings };
}
