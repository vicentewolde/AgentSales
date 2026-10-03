import { type AbortSignalLike, AppError, type MediaProcessor } from "@agentsales/core";
import { processImage } from "./image.js";
import { MEDIA_PIPELINE_VERSION } from "./pipeline.js";
import { runTool, throwIfAborted } from "./run.js";
import { FFMPEG_INSTALL_HINT, isSupportedFfmpeg, parseFfmpegVersion } from "./tools.js";
import { processVideo } from "./video.js";

export {
  IMAGE_VARIANT_SPECS,
  type ImageVariantSpec,
  MEDIA_PIPELINE_VERSION,
  REEL_SPEC,
} from "./pipeline.js";

export type MediaProcessorOptions = {
  /** `FFMPEG_PATH`: el ejecutable de ffmpeg (8.1 o más nuevo). */
  ffmpegPath: string;
  /** `FFPROBE_PATH`: el de ffprobe (videos). */
  ffprobePath: string;
  /**
   * Directorio temporal del intento (spec F2 §4.4): el procesador deja aquí sus archivos de
   * trabajo (también el reel, hasta que se sube), y el worker lo borra entero al terminar.
   */
  workDir: string;
  /**
   * Hilos de ffmpeg al armar el reel (filtros y codificador); sin valor, ffmpeg usa todos los
   * núcleos. **Reduce** el uso, no lo limita del todo (el escalado y el lookahead de x264 usan algo
   * más). Los tests usan 2, para no atrasar a los demás tests que corren en paralelo.
   */
  threads?: number;
};

/**
 * Revisa una vez que una herramienta sea 8.1 o más nueva. Es una sola llamada corta (`-version`)
 * compartida por todos los medios: corre sin el `signal` de quien la pidió primero, para que cortar
 * un medio no corte la revisión de otro. Si falla, la próxima vez se revisa de nuevo (por ejemplo,
 * después de instalarla).
 */
function toolCheck(path: string, name: "ffmpeg" | "ffprobe") {
  let checked: Promise<void> | null = null;
  return async (signal?: AbortSignalLike) => {
    throwIfAborted(signal);
    if (checked === null) {
      const check = runTool(path, ["-hide_banner", "-version"]).then((output) => {
        const version = parseFfmpegVersion(output.toString("utf8"));
        if (!isSupportedFfmpeg(version)) {
          throw new AppError(
            "MEDIA_TOOL_NOT_INSTALLED",
            `${name} ${version?.major}.${version?.minor} es anterior a 8.1. ${FFMPEG_INSTALL_HINT}`,
          );
        }
      });
      checked = check;
      check.catch(() => {
        if (checked === check) checked = null;
      });
    }
    await checked;
    throwIfAborted(signal);
  };
}

/**
 * El procesador de medios (puerto `MediaProcessor`, spec F2 §4.2) con sharp, ffmpeg y ffprobe. El
 * worker crea uno por intento. Las versiones se revisan una vez, la primera vez que hacen falta.
 */
export function createMediaProcessor(options: MediaProcessorOptions): MediaProcessor {
  const ensureFfmpeg = toolCheck(options.ffmpegPath, "ffmpeg");
  const ensureFfprobe = toolCheck(options.ffprobePath, "ffprobe");
  const ensureTools = async (signal?: AbortSignalLike) => {
    await ensureFfmpeg(signal);
    await ensureFfprobe(signal);
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
    processVideo: (input, opts, signal) =>
      processVideo(
        input,
        opts,
        {
          ffmpegPath: options.ffmpegPath,
          ffprobePath: options.ffprobePath,
          workDir: options.workDir,
          ...(options.threads === undefined ? {} : { threads: options.threads }),
          ensureTools,
        },
        signal,
      ),
  };
}
