import { AppError, type LogoNormalizer } from "@agentsales/core";
import sharp from "sharp";

// El logo que sube un corredor (spec F7 §4.6): solo con sharp (sin ffmpeg ni el navegador), para
// que la API lo componga sin cargar el resto de `@agentsales/media`.

/** Los formatos que se aceptan, según lo que lee sharp del contenido (no del nombre). */
const ACCEPTED_FORMATS = new Set(["png", "jpeg", "webp"]);
/** El lado más largo del PNG guardado: de sobra para la portada y la ficha. */
const MAX_SIDE = 1024;
/** Tope de píxeles al decodificar (una bomba de descompresión no se procesa). */
const MAX_INPUT_PIXELS = 50_000_000;

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
