import { type AbortSignalLike, AppError, type MediaProcessor } from "@agentsales/core";
import { processImage } from "./image.js";
import { MEDIA_PIPELINE_VERSION } from "./pipeline.js";
import { runTool, throwIfAborted } from "./run.js";
import { FFMPEG_INSTALL_HINT, isSupportedFfmpeg, parseFfmpegVersion } from "./tools.js";

export { IMAGE_VARIANT_SPECS, type ImageVariantSpec, MEDIA_PIPELINE_VERSION } from "./pipeline.js";

export type MediaProcessorOptions = {
  /** `FFMPEG_PATH`: el ejecutable de ffmpeg (8.1 o más nuevo). */
  ffmpegPath: string;
  /** `FFPROBE_PATH`: el de ffprobe (videos, F2-T08). */
  ffprobePath: string;
  /**
   * Directorio temporal del intento (spec F2 §4.4): el procesador deja aquí sus archivos de
   * trabajo, y el worker lo borra entero al terminar el intento.
   */
  workDir: string;
};

/**
 * El procesador de medios (puerto `MediaProcessor`, spec F2 §4.2) con sharp y ffmpeg. El worker
 * crea uno por intento. La versión de ffmpeg se revisa una vez, la primera vez que hace falta.
 */
export function createMediaProcessor(options: MediaProcessorOptions): MediaProcessor {
  // La revisión es una sola llamada corta (`-version`) compartida por todas las fotos: corre sin el
  // `signal` de quien la pidió primero, para que cortar una foto no corte la revisión de otra.
  let ffmpegChecked: Promise<void> | null = null;
  const ensureFfmpeg = async (signal?: AbortSignalLike) => {
    throwIfAborted(signal);
    if (ffmpegChecked === null) {
      const check = runTool(options.ffmpegPath, ["-hide_banner", "-version"]).then((output) => {
        const version = parseFfmpegVersion(output.toString("utf8"));
        if (!isSupportedFfmpeg(version)) {
          throw new AppError(
            "MEDIA_TOOL_NOT_INSTALLED",
            `ffmpeg ${version?.major}.${version?.minor} es anterior a 8.1 y no arma las fotos HEIC. ${FFMPEG_INSTALL_HINT}`,
          );
        }
      });
      ffmpegChecked = check;
      // Si falló, la próxima foto vuelve a revisar (por ejemplo, después de instalarlo).
      check.catch(() => {
        if (ffmpegChecked === check) ffmpegChecked = null;
      });
    }
    await ffmpegChecked;
    throwIfAborted(signal);
  };

  return {
    version: MEDIA_PIPELINE_VERSION,
    processImage: (input, opts, signal) =>
      processImage(
        input,
        opts,
        { ffmpegPath: options.ffmpegPath, workDir: options.workDir, ensureFfmpeg },
        signal,
      ),
    async processVideo() {
      throw new AppError(
        "MEDIA_VIDEO_NOT_IMPLEMENTED",
        "El procesamiento de video llega en F2-T08",
      );
    },
  };
}
