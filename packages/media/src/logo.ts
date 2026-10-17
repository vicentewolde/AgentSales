import { AppError, type LogoNormalizer } from "@agentsales/core";
import sharp from "sharp";

// El logo que sube un corredor (spec F7 §4.6): solo con sharp (sin ffmpeg ni el navegador), para
// que la API lo componga sin cargar el resto de `@agentsales/media`.

/** Los formatos que se aceptan, según lo que lee sharp del contenido (no del nombre). */
const ACCEPTED_FORMATS = new Set(["png", "jpeg", "webp"]);
/** El lado más largo del PNG guardado: de sobra para la portada y la ficha. */
const MAX_SIDE = 1024;
/**
 * Tope de píxeles al decodificar (4096 × 4096): una bomba de descompresión (un PNG de pocos KB y
 * miles de píxeles por lado) no se decodifica entera en la Mac de 8 GB.
 */
const MAX_INPUT_PIXELS = 4096 * 4096;

/**
 * Los primeros bytes de PNG, JPEG y WebP: lo demás (un SVG, sobre todo) ni siquiera llega al
 * decodificador de sharp.
 */
function hasAcceptedSignature(input: Uint8Array): boolean {
  const starts = (bytes: readonly number[], offset = 0) =>
    bytes.every((byte, index) => input[offset + index] === byte);
  return (
    starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    starts([0xff, 0xd8, 0xff]) ||
    (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8))
  );
}

const invalid = (cause?: unknown) =>
  new AppError("LOGO_INVALID", "El logo debe ser una imagen PNG, JPEG o WebP", { cause });

/**
 * `LogoNormalizer` con sharp: PNG, JPEG o WebP (por el contenido; un SVG, HEIC, GIF o un archivo
 * dañado es `LOGO_INVALID`), rotado según el EXIF, sin metadatos, con su transparencia y a lo más
 * `MAX_SIDE` px por lado (sin agrandar).
 */
export function createLogoNormalizer(): LogoNormalizer {
  return {
    async normalize(input) {
      if (!hasAcceptedSignature(input)) throw invalid();
      let format: string | undefined;
      try {
        format = (await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()).format;
      } catch (error) {
        throw invalid(error);
      }
      if (format === undefined || !ACCEPTED_FORMATS.has(format)) throw invalid();
      try {
        const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
          .rotate()
          .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
          .png()
          .toBuffer({ resolveWithObject: true });
        return { bytes: new Uint8Array(data), width: info.width, height: info.height };
      } catch (error) {
        throw invalid(error);
      }
    },
  };
}
