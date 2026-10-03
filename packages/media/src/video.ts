import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import {
  type AbortSignalLike,
  MEDIA_WARNING_TEXT,
  type MediaWarning,
  type MediaWarningCode,
  type ProcessedVideo,
  type VideoOutput,
} from "@agentsales/core";
import { z } from "zod";
import { decodeFailed, renderVariant } from "./image.js";
import { REEL_SPEC } from "./pipeline.js";
import { CommandFailedError, runTool, throwIfAborted } from "./run.js";

export type VideoToolOptions = {
  ffmpegPath: string;
  ffprobePath: string;
  /** Directorio temporal del intento: el video, el PNG del texto y el reel quedan aquí. */
  workDir: string;
  /** Hilos de ffmpeg al armar el reel (sin valor, todos los núcleos). */
  threads?: number;
  /** Revisa una vez que ffmpeg y ffprobe sean 8.1 o más nuevos. */
  ensureTools: (signal?: AbortSignalLike) => Promise<void>;
};

/** Lo que importa de `ffprobe -show_streams -show_format` (JSON). */
const probeSchema = z.object({
  streams: z.array(
    z.looseObject({
      codec_type: z.string(),
      width: z.number().optional(),
      height: z.number().optional(),
      side_data_list: z.array(z.looseObject({ rotation: z.number().optional() })).optional(),
      tags: z.record(z.string(), z.string()).optional(),
    }),
  ),
  format: z.looseObject({ duration: z.string().optional() }),
});

type Probe = { width: number; height: number; durationS: number; hasAudio: boolean };

const warning = (code: MediaWarningCode): MediaWarning => ({
  code,
  message: MEDIA_WARNING_TEXT[code],
});

/** Corre una herramienta; si termina con error, el archivo no se pudo leer. */
async function runOrDecodeFailed(
  command: string,
  args: string[],
  signal?: AbortSignalLike,
): Promise<Buffer> {
  try {
    return await runTool(command, args, signal);
  } catch (error) {
    throw error instanceof CommandFailedError ? decodeFailed(error) : error;
  }
}

/** Copia el video al temporal del intento: ffprobe y ffmpeg necesitan moverse por el archivo. */
async function writeInput(
  input: AsyncIterable<Uint8Array>,
  path: string,
  signal?: AbortSignalLike,
): Promise<void> {
  const file = createWriteStream(path);
  try {
    for await (const chunk of input) {
      throwIfAborted(signal);
      if (!file.write(chunk)) await new Promise((resolve) => file.once("drain", resolve));
    }
  } finally {
    file.end();
    await finished(file);
  }
}

/** Medidas (ya giradas), duración y si tiene audio. */
async function probe(path: string, options: VideoToolOptions, signal?: AbortSignalLike) {
  const output = await runOrDecodeFailed(
    options.ffprobePath,
    ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path],
    signal,
  );
  let parsed: z.infer<typeof probeSchema>;
  try {
    parsed = probeSchema.parse(JSON.parse(output.toString("utf8")));
  } catch (error) {
    throw decodeFailed(error);
  }
  const video = parsed.streams.find((stream) => stream.codec_type === "video");
  const durationS = Number(parsed.format.duration);
  if (!video?.width || !video.height || !Number.isFinite(durationS) || durationS <= 0) {
    throw decodeFailed();
  }
  // El giro del celular: en la matriz de presentación (o en la etiqueta vieja `rotate`).
  const rotation =
    video.side_data_list?.find((data) => data.rotation !== undefined)?.rotation ??
    Number(video.tags?.rotate ?? 0);
  const turned = Math.abs(rotation) % 180 === 90;
  return {
    width: turned ? video.height : video.width,
    height: turned ? video.width : video.height,
    durationS,
    hasAudio: parsed.streams.some((stream) => stream.codec_type === "audio"),
  } satisfies Probe;
}

/** Un cuadro del video en JPEG de alta calidad (ffmpeg ya lo endereza). */
async function frameAt(
  path: string,
  atS: number,
  options: VideoToolOptions,
  signal?: AbortSignalLike,
): Promise<Buffer> {
  const args = [
    ...["-hide_banner", "-loglevel", "error", "-nostdin"],
    ...["-ss", atS.toFixed(3), "-i", path],
    ...[
      "-frames:v",
      "1",
      "-map_metadata",
      "-1",
      "-q:v",
      "2",
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "pipe:1",
    ],
  ];
  const frame = await runOrDecodeFailed(options.ffmpegPath, args, signal);
  if (frame.length === 0) throw decodeFailed();
  return frame;
}

/** El grafo del reel: fondo desenfocado, el video al centro y el texto encima los primeros 2 s. */
function reelFilter(): string {
  const { width, height, fps, blur, overlayS } = REEL_SPEC;
  return [
    `[0:v]fps=${fps},split=2[bg][fg]`,
    `[bg]scale=${blur.width}:${blur.height}:force_original_aspect_ratio=increase,crop=${blur.width}:${blur.height},boxblur=${blur.radius}:2,scale=${width}:${height}[blurred]`,
    `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[front]`,
    "[blurred][front]overlay=(W-w)/2:(H-h)/2[base]",
    `[1:v]scale=${width}:${height},format=rgba[text]`,
    `[base][text]overlay=0:0:enable='lt(t,${overlayS})',format=yuv420p,setsar=1[v]`,
  ].join(";");
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Arma el reel en el temporal; lo sube quien lo pide, con `open()` y `putStream`. */
async function encodeReel(
  path: string,
  source: Probe,
  overlayPng: Uint8Array,
  options: VideoToolOptions,
  signal?: AbortSignalLike,
): Promise<VideoOutput> {
  const id = randomUUID();
  const overlayPath = join(options.workDir, `${id}-texto.png`);
  const reelPath = join(options.workDir, `${id}-reel.mp4`);
  await writeFile(overlayPath, overlayPng);
  const durationS = Math.min(source.durationS, REEL_SPEC.maxDurationS);
  const { x264, audio, fps } = REEL_SPEC;
  const gop = x264.gop;
  // Filtros (global) y codificador (opción de salida): sin valor, ffmpeg usa todos los núcleos.
  const threads = options.threads === undefined ? null : String(options.threads);
  // Un video sin audio recibe una pista silenciosa: Instagram la espera.
  const silence = source.hasAudio
    ? []
    : [
        "-f",
        "lavfi",
        "-t",
        durationS.toFixed(3),
        "-i",
        `anullsrc=channel_layout=stereo:sample_rate=${audio.sampleRate}`,
      ];
  const args = [
    ...["-hide_banner", "-loglevel", "error", "-nostdin", "-y"],
    ...(threads === null ? [] : ["-filter_complex_threads", threads]),
    ...["-i", path, "-i", overlayPath, ...silence],
    ...[
      "-filter_complex",
      reelFilter(),
      "-map",
      "[v]",
      "-map",
      source.hasAudio ? "0:a:0" : "2:a:0",
    ],
    ...["-t", durationS.toFixed(3), "-r", String(fps)],
    ...["-c:v", "libx264", "-preset", x264.preset, "-profile:v", "high", "-crf", String(x264.crf)],
    ...(threads === null ? [] : ["-threads", threads]),
    ...["-maxrate", x264.maxrate, "-bufsize", x264.bufsize],
    // GOP cerrado y fijo: un cuadro clave cada 2 s, sin cortes por cambio de escena.
    ...["-g", String(gop), "-keyint_min", String(gop), "-sc_threshold", "0", "-flags", "+cgop"],
    ...["-c:a", "aac", "-b:a", audio.bitrate, "-ac", "2", "-ar", String(audio.sampleRate)],
    // `moov` al inicio y sin edit lists (requisitos de la API de Instagram).
    ...["-movflags", "+faststart", "-use_editlist", "0", "-map_metadata", "-1", reelPath],
  ];
  try {
    await runOrDecodeFailed(options.ffmpegPath, args, signal);
  } finally {
    await rm(overlayPath, { force: true });
  }
  const output = await probe(reelPath, options, signal);
  return {
    size: (await stat(reelPath)).size,
    sha256: await sha256OfFile(reelPath),
    width: output.width,
    height: output.height,
    durationS: output.durationS,
    open: () => createReadStream(reelPath) as AsyncIterable<Uint8Array>,
  };
}

/**
 * Un video → sus medidas, su `thumb` y, con `reel`, el reel de Instagram (spec F2 §4.2, D5). Un
 * video de menos de 3 s no da reel; uno de más de 90 s se corta. Todo queda en el temporal del
 * intento, que el worker borra al terminar (el reel también: se sube antes con `open()`).
 */
export async function processVideo(
  input: AsyncIterable<Uint8Array>,
  { reel }: { reel: { overlayPng: Uint8Array } | null },
  options: VideoToolOptions,
  signal?: AbortSignalLike,
): Promise<ProcessedVideo> {
  throwIfAborted(signal);
  await options.ensureTools(signal);
  const path = join(options.workDir, `${randomUUID()}-video`);
  try {
    await writeInput(input, path, signal);
    const source = await probe(path, options, signal);
    const frame = await frameAt(
      path,
      Math.min(REEL_SPEC.thumbAtS, source.durationS / 2),
      options,
      signal,
    );
    const thumb = await renderVariant(frame, "thumb");

    const warnings: MediaWarning[] = [];
    let output: VideoOutput | null = null;
    if (reel !== null) {
      if (source.durationS < REEL_SPEC.minDurationS) {
        warnings.push(warning("VIDEO_TOO_SHORT"));
      } else {
        if (source.durationS > REEL_SPEC.maxDurationS) warnings.push(warning("VIDEO_TRIMMED"));
        output = await encodeReel(path, source, reel.overlayPng, options, signal);
      }
    }
    return {
      measurements: { width: source.width, height: source.height, durationS: source.durationS },
      thumb,
      reel: output,
      warnings,
    };
  } finally {
    await rm(path, { force: true });
  }
}
