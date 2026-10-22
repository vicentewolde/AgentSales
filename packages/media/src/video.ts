import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type AbortSignalLike,
  AppError,
  discordVideoBitrateKbps,
  isAppError,
  type MusicInput,
  type PhotoReelOptions,
  type ProcessedVideo,
  REEL_MIN_DURATION_S,
  type ReelPhotoInput,
  type VideoOutput,
  type VideoProcessOptions,
} from "@agentsales/core";
import sharp from "sharp";
import { z } from "zod";
import { decodableSource, decodeFailed, renderVariant } from "./image.js";
import {
  DISCORD_VIDEO_SPEC,
  MUSIC_SPEC,
  PHOTO_REEL_SPEC,
  REEL_SPEC,
  X_VIDEO_SPEC,
} from "./pipeline.js";
import { aborted, CommandFailedError, runTool, throwIfAborted } from "./run.js";

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
      duration: z.string().optional(),
      disposition: z.looseObject({ attached_pic: z.number().optional() }).optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      side_data_list: z.array(z.looseObject({ rotation: z.number().optional() })).optional(),
      tags: z.record(z.string(), z.string()).optional(),
    }),
  ),
  format: z.looseObject({ duration: z.string().optional() }),
});

type Probe = { width: number; height: number; durationS: number; hasAudio: boolean };

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

/**
 * Copia el video al temporal del intento: ffprobe y ffmpeg necesitan moverse por el archivo. Con
 * `pipeline`, un error de escritura (disco lleno) rechaza en vez de quedar sin manejar.
 */
async function writeInput(
  input: AsyncIterable<Uint8Array>,
  path: string,
  signal?: AbortSignalLike,
): Promise<void> {
  throwIfAborted(signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await pipeline(Readable.from(input), createWriteStream(path), { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw aborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
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
  // La pista de video de verdad, no una carátula adjunta (algunos mp4 traen una).
  const video = parsed.streams.find(
    (stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1,
  );
  // Algunos contenedores (mkv, webm) no dan la duración general: vale la de la pista.
  const durationS = Number(parsed.format.duration ?? video?.duration);
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

/**
 * El grafo del reel: fondo desenfocado, el video al centro y, si hay, el texto encima los primeros
 * 2 s (el de un aviso). Sin texto (un post, F9-T10) termina en el mismo formato; el grafo con texto
 * no cambia (no sube `MEDIA_PIPELINE_VERSION`).
 */
function reelFilter(withText: boolean): string {
  const { width, height, fps, blur, overlayS } = REEL_SPEC;
  const background = [
    `[0:v]fps=${fps},split=2[bg][fg]`,
    `[bg]scale=${blur.width}:${blur.height}:force_original_aspect_ratio=increase,crop=${blur.width}:${blur.height},boxblur=${blur.radius}:2,scale=${width}:${height}[blurred]`,
    `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[front]`,
  ];
  if (!withText) {
    return [
      ...background,
      "[blurred][front]overlay=(W-w)/2:(H-h)/2,format=yuv420p,setsar=1[v]",
    ].join(";");
  }
  return [
    ...background,
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

/** Un video armado en el temporal, medido y con su sha256: lo sube quien lo pide (`open()`). */
async function outputOf(
  path: string,
  options: VideoToolOptions,
  signal?: AbortSignalLike,
): Promise<VideoOutput> {
  const output = await probe(path, options, signal);
  return {
    size: (await stat(path)).size,
    sha256: await sha256OfFile(path),
    width: output.width,
    height: output.height,
    durationS: output.durationS,
    open: () => createReadStream(path) as AsyncIterable<Uint8Array>,
  };
}

/**
 * La pista de audio silenciosa de un reel sin audio ni música (Instagram la espera), como entrada
 * de ffmpeg. Con música (F9.5-T19), la música entra en su lugar (`musicInput`).
 */
function silentAudioInput(durationS: number): string[] {
  return [
    ...["-f", "lavfi", "-t", durationS.toFixed(3)],
    ...["-i", `anullsrc=channel_layout=stereo:sample_rate=${REEL_SPEC.audio.sampleRate}`],
  ];
}

/** Deja la pista de música en el temporal del intento (ffmpeg la lee de un archivo). */
async function writeMusic(music: MusicInput, options: VideoToolOptions): Promise<string> {
  const path = join(options.workDir, `${randomUUID()}-musica`);
  await writeFile(path, music.bytes);
  return path;
}

/** La música como entrada de ffmpeg: en bucle, por si es más corta que el video. */
function musicInput(path: string): string[] {
  return ["-stream_loop", "-1", "-i", path];
}

/**
 * El grafo de audio con música (F9.5-T19, `MUSIC_SPEC`), que termina en `[a]`: la música (la
 * entrada `music`) recortada a `durationS`, con un fundido de entrada y otro de salida. Con `voice`
 * (el sonido del video, como `0:a:0`), la música va detrás, a `underVoiceDb`, y se suma al sonido
 * sin normalizar (la voz queda a su volumen); sin `voice`, la música sola a `aloneDb`.
 */
export function musicAudioFilter(voice: string | null, music: number, durationS: number): string {
  const { sampleRate, fadeInS, underVoiceDb, aloneDb } = MUSIC_SPEC;
  const format = `aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo`;
  const end = durationS.toFixed(3);
  const fadeOutS = Math.min(MUSIC_SPEC.fadeOutS, durationS / 3);
  const fadeOutStart = Math.max(0, durationS - fadeOutS).toFixed(3);
  const musicChain = [
    `[${music}:a:0]${format}`,
    `atrim=end=${end}`,
    "asetpts=N/SR/TB",
    `volume=${voice === null ? aloneDb : underVoiceDb}dB`,
    `afade=t=in:st=0:d=${Math.min(fadeInS, durationS / 3).toFixed(3)}`,
    `afade=t=out:st=${fadeOutStart}:d=${fadeOutS.toFixed(3)}`,
  ].join(",");
  if (voice === null) return `${musicChain}[a]`;
  return [
    `${musicChain}[music]`,
    `[${voice}]${format},apad,atrim=end=${end},asetpts=N/SR/TB[voice]`,
    "[voice][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]",
  ].join(";");
}

/** Hilos de ffmpeg (filtros y codificador): sin valor, ffmpeg usa todos los núcleos. */
const threadsOf = (options: VideoToolOptions) =>
  options.threads === undefined ? null : String(options.threads);

/**
 * Corre ffmpeg con la música y, si falla, otra vez sin ella (F9.5-T19): una pista que ffmpeg no
 * puede leer deja el video sin música, no sin video. Devuelve si quedó sin la música pedida; si
 * también falla sin música, el error es del video. El corte (`MEDIA_ABORTED`) no se reintenta.
 */
async function withMusicFallback(
  musicPath: string | null,
  run: (musicPath: string | null) => Promise<unknown>,
): Promise<boolean> {
  if (musicPath === null) {
    await run(null);
    return false;
  }
  try {
    await run(musicPath);
    return false;
  } catch (error) {
    if (isAppError(error) && error.code === "MEDIA_ABORTED") throw error;
    await run(null);
    return true;
  }
}

/** La salida, marcada si quedó sin la música pedida. */
const markedOutput = (output: VideoOutput, withoutMusic: boolean): VideoOutput =>
  withoutMusic ? { ...output, withoutMusic: true } : output;

/**
 * Lo que comparten los dos reels (el de un video y el de fotos) después de los filtros: duración,
 * codificador (`REEL_SPEC`), audio AAC y el contenedor que pide Instagram.
 */
function reelOutputArgs(durationS: number, threads: string | null, outPath: string): string[] {
  const { x264, audio, fps } = REEL_SPEC;
  const gop = x264.gop;
  return [
    ...["-t", durationS.toFixed(3), "-r", String(fps)],
    ...["-c:v", "libx264", "-preset", x264.preset, "-profile:v", "high", "-crf", String(x264.crf)],
    ...(threads === null ? [] : ["-threads", threads]),
    ...["-maxrate", x264.maxrate, "-bufsize", x264.bufsize],
    // GOP cerrado y fijo: un cuadro clave cada 2 s, sin cortes por cambio de escena.
    ...["-g", String(gop), "-keyint_min", String(gop), "-sc_threshold", "0", "-flags", "+cgop"],
    ...["-c:a", "aac", "-b:a", audio.bitrate, "-ac", "2", "-ar", String(audio.sampleRate)],
    // `moov` al inicio y sin edit lists (requisitos de la API de Instagram).
    ...["-movflags", "+faststart", "-use_editlist", "0", "-map_metadata", "-1", outPath],
  ];
}

/**
 * Arma el reel en el temporal; lo sube quien lo pide, con `open()` y `putStream`. Con
 * `overlayPng = null`, sin texto encima.
 */
async function encodeReel(
  path: string,
  source: Probe,
  overlayPng: Uint8Array | null,
  musicPath: string | null,
  options: VideoToolOptions,
  signal?: AbortSignalLike,
): Promise<VideoOutput> {
  const id = randomUUID();
  const overlayPath = overlayPng === null ? null : join(options.workDir, `${id}-texto.png`);
  const reelPath = join(options.workDir, `${id}-reel.mp4`);
  if (overlayPath !== null && overlayPng !== null) await writeFile(overlayPath, overlayPng);
  const durationS = Math.min(source.durationS, REEL_SPEC.maxDurationS);
  const threads = threadsOf(options);
  // La música, o la pista silenciosa de un video sin audio (Instagram la espera), va después del
  // video y, si hay, del texto.
  const audioIndex = overlayPath === null ? 1 : 2;
  const argsFor = (music: string | null) => {
    const audioInput =
      music !== null ? musicInput(music) : source.hasAudio ? [] : silentAudioInput(durationS);
    const filter =
      music === null
        ? reelFilter(overlayPath !== null)
        : `${reelFilter(overlayPath !== null)};${musicAudioFilter(source.hasAudio ? "0:a:0" : null, audioIndex, durationS)}`;
    const audioMap = music !== null ? "[a]" : source.hasAudio ? "0:a:0" : `${audioIndex}:a:0`;
    return [
      ...["-hide_banner", "-loglevel", "error", "-nostdin", "-y"],
      ...(threads === null ? [] : ["-filter_complex_threads", threads]),
      ...["-i", path, ...(overlayPath === null ? [] : ["-i", overlayPath]), ...audioInput],
      ...["-filter_complex", filter, "-map", "[v]", "-map", audioMap],
      ...reelOutputArgs(durationS, threads, reelPath),
    ];
  };
  let withoutMusic: boolean;
  try {
    // Un fallo al armar el reel (también del codificador o del disco) es MEDIA_DECODE_FAILED: la
    // corrida lo toma como aviso de ese video, sin reel, y la siguiente lo vuelve a intentar.
    withoutMusic = await withMusicFallback(musicPath, (music) =>
      runOrDecodeFailed(options.ffmpegPath, argsFor(music), signal),
    );
  } catch (error) {
    await rm(reelPath, { force: true });
    throw error;
  } finally {
    if (overlayPath !== null) await rm(overlayPath, { force: true });
  }
  return markedOutput(await outputOf(reelPath, options, signal), withoutMusic);
}

/**
 * Un cuadro 1080×1920 del reel con fotos (`PHOTO_REEL_SPEC`): la foto entera al centro (sin
 * recorte; una chica se amplía hasta el ancho o el alto) sobre ella misma recortada a 9:16,
 * desenfocada en chico y ampliada. Girada según su EXIF, sobre blanco si es transparente, en sRGB.
 */
async function photoReelFrame(source: Buffer): Promise<Buffer> {
  const { width, height } = REEL_SPEC;
  const { blur, frameQuality } = PHOTO_REEL_SPEC;
  const base = () =>
    sharp(source).rotate().flatten({ background: "#ffffff" }).toColourspace("srgb");
  try {
    const front = await base()
      .resize(width, height, { fit: "inside" })
      .jpeg({ quality: frameQuality })
      .toBuffer();
    const small = await base()
      .resize(blur.width, blur.height, { fit: "cover", position: "centre" })
      .blur(blur.sigma)
      .png()
      .toBuffer();
    return await sharp(small)
      .resize(width, height, { fit: "fill" })
      .composite([{ input: front, gravity: "centre" }])
      .jpeg({ quality: frameQuality })
      .toBuffer();
  } catch (error) {
    throw decodeFailed(error);
  }
}

/**
 * El grafo del reel con fotos: cada cuadro fijo (una entrada por foto) a 30 fps, unidos con
 * fundidos (`xfade`) y, si hay, el texto encima los primeros 2 s, como en el reel de un video.
 */
function photoReelFilter(count: number, withText: boolean): string {
  const { width, height, fps, overlayS } = REEL_SPEC;
  const { slideS, fadeS } = PHOTO_REEL_SPEC;
  // Un JPEG llega en rango completo (yuvj420p): pasa al rango de video (yuv420p), como un video.
  const parts = Array.from(
    { length: count },
    (_, index) =>
      `[${index}:v]scale=in_range=full:out_range=tv,format=yuv420p,fps=${fps},setsar=1,settb=AVTB[p${index}]`,
  );
  let last = "p0";
  for (let index = 1; index < count; index++) {
    const out = `x${index}`;
    const offset = (index * slideS).toFixed(3);
    parts.push(
      `[${last}][p${index}]xfade=transition=fade:duration=${fadeS}:offset=${offset}[${out}]`,
    );
    last = out;
  }
  if (withText) {
    parts.push(`[${count}:v]scale=${width}:${height},format=rgba[text]`);
    parts.push(`[${last}][text]overlay=0:0:enable='lt(t,${overlayS})',format=yuv420p,setsar=1[v]`);
  } else {
    parts.push(`[${last}]format=yuv420p,setsar=1[v]`);
  }
  return parts.join(";");
}

/**
 * El reel de una propiedad sin video, armado con sus fotos (F9.5-T18, `PHOTO_REEL_SPEC`), en el
 * temporal; lo sube quien lo pide (`open()`). Las fotos van en el orden recibido (core pone la
 * portada primero); cada una se lee, se vuelve un cuadro JPEG en el temporal y se suelta antes de
 * leer la siguiente. Dura `slideS` por foto, con una pista silenciosa (Instagram espera audio).
 * Una foto ilegible o un fallo de ffmpeg es `MEDIA_DECODE_FAILED`.
 */
export async function encodeReelFromPhotos(
  photos: readonly ReelPhotoInput[],
  { overlayPng, music = null }: PhotoReelOptions,
  options: VideoToolOptions,
  signal?: AbortSignalLike,
): Promise<VideoOutput> {
  throwIfAborted(signal);
  const { minPhotos, maxPhotos, slideS, fadeS } = PHOTO_REEL_SPEC;
  if (photos.length < minPhotos || photos.length > maxPhotos) {
    throw new AppError(
      "MEDIA_REEL_PHOTOS_INVALID",
      `El reel con fotos pide entre ${minPhotos} y ${maxPhotos} fotos`,
      { details: { photos: photos.length } },
    );
  }
  await options.ensureTools(signal);
  const id = randomUUID();
  // Cada foto con la ruta de su cuadro en el temporal.
  const frames = photos.map((photo, index) => ({
    photo,
    path: join(options.workDir, `${id}-foto-${index}.jpg`),
  }));
  const framePaths = frames.map((frame) => frame.path);
  const overlayPath = overlayPng === null ? null : join(options.workDir, `${id}-texto.png`);
  const reelPath = join(options.workDir, `${id}-reel.mp4`);
  const durationS = photos.length * slideS;
  const threads = threadsOf(options);
  const imageOptions = { ...options, ensureFfmpeg: options.ensureTools };
  let musicPath: string | null = null;
  let withoutMusic = false;
  try {
    for (const { photo, path } of frames) {
      throwIfAborted(signal);
      const source = await decodableSource(await photo.read(), photo.mime, imageOptions, signal);
      await writeFile(path, await photoReelFrame(source));
    }
    if (overlayPath !== null && overlayPng !== null) await writeFile(overlayPath, overlayPng);
    // Cada cuadro dura su parte más el fundido hacia la siguiente; el último, solo su parte. Un
    // hilo por decodificador: son cuadros fijos, y con uno por núcleo la memoria se multiplica.
    const inputs = framePaths.flatMap((path, index) => [
      ...["-threads", "1", "-loop", "1", "-framerate", String(REEL_SPEC.fps)],
      ...["-t", (index < framePaths.length - 1 ? slideS + fadeS : slideS).toFixed(3)],
      ...["-i", path],
    ]);
    // La música (F9.5-T19), o la pista silenciosa, va después de las fotos y, si hay, del texto.
    const audioIndex = photos.length + (overlayPath === null ? 0 : 1);
    if (music !== null) musicPath = await writeMusic(music, options);
    const videoFilter = photoReelFilter(photos.length, overlayPath !== null);
    const argsFor = (music: string | null) => [
      ...["-hide_banner", "-loglevel", "error", "-nostdin", "-y"],
      ...(threads === null ? [] : ["-filter_complex_threads", threads]),
      ...inputs,
      ...(overlayPath === null ? [] : ["-i", overlayPath]),
      ...(music === null ? silentAudioInput(durationS) : musicInput(music)),
      ...[
        "-filter_complex",
        music === null
          ? videoFilter
          : `${videoFilter};${musicAudioFilter(null, audioIndex, durationS)}`,
      ],
      ...["-map", "[v]", "-map", music === null ? `${audioIndex}:a:0` : "[a]"],
      ...reelOutputArgs(durationS, threads, reelPath),
    ];
    withoutMusic = await withMusicFallback(musicPath, (music) =>
      runOrDecodeFailed(options.ffmpegPath, argsFor(music), signal),
    );
  } catch (error) {
    await rm(reelPath, { force: true });
    throw error;
  } finally {
    for (const path of framePaths) await rm(path, { force: true });
    if (overlayPath !== null) await rm(overlayPath, { force: true });
    if (musicPath !== null) await rm(musicPath, { force: true });
  }
  return markedOutput(await outputOf(reelPath, options, signal), withoutMusic);
}

/** Lo que dura como mínimo un video en X (la guía de medios: 0,5 s). */
export const X_VIDEO_MIN_DURATION_S = 0.5;

/** Un número par (H.264 4:2:0 pide medidas pares), al menos 2. */
const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);

/**
 * Las medidas del video para X: caben en 1280×720 (horizontal), 720×1280 (vertical) o 720×720
 * (cuadrado), sin ampliar y con la proporción del original (`X_VIDEO_SPEC`).
 */
export function xVideoSize(source: { width: number; height: number }): {
  width: number;
  height: number;
} {
  return fitInside(source, X_VIDEO_SPEC);
}

/** Las medidas del video para Discord: como las de X, caben en 720p sin ampliar. */
export function discordVideoSize(source: { width: number; height: number }): {
  width: number;
  height: number;
} {
  return fitInside(source, DISCORD_VIDEO_SPEC);
}

function fitInside(
  source: { width: number; height: number },
  { longSide, shortSide }: { longSide: number; shortSide: number },
): { width: number; height: number } {
  const [maxWidth, maxHeight] =
    source.width > source.height
      ? [longSide, shortSide]
      : source.width < source.height
        ? [shortSide, longSide]
        : [shortSide, shortSide];
  const scale = Math.min(1, maxWidth / source.width, maxHeight / source.height);
  return { width: even(source.width * scale), height: even(source.height * scale) };
}

/**
 * Las entradas, los filtros y las pistas de un video reducido (X o Discord) con su filtro de video
 * `vf`. Sin música, como siempre: `-vf` y el audio del original tal cual (si tiene). Con música
 * (F9.5-T19), un grafo con el video y el audio mezclado (`musicAudioFilter`), con la duración del
 * original: siempre lleva audio.
 */
function reducedStreams(
  path: string,
  source: Probe,
  vf: string,
  musicPath: string | null,
  threads: string | null,
): { args: string[]; withAudio: boolean } {
  if (musicPath === null) {
    return {
      args: [
        ...(threads === null ? [] : ["-filter_threads", threads]),
        ...["-i", path, "-map", "0:v:0", ...(source.hasAudio ? ["-map", "0:a:0"] : [])],
        ...["-vf", vf],
      ],
      withAudio: source.hasAudio,
    };
  }
  const audio = musicAudioFilter(source.hasAudio ? "0:a:0" : null, 1, source.durationS);
  return {
    args: [
      ...(threads === null ? [] : ["-filter_complex_threads", threads]),
      ...["-i", path, ...musicInput(musicPath)],
      ...["-filter_complex", `[0:v:0]${vf}[v];${audio}`, "-map", "[v]", "-map", "[a]"],
      ...["-t", source.durationS.toFixed(3)],
    ],
    withAudio: true,
  };
}

/** Arma el video para X en el temporal (`X_VIDEO_SPEC`); lo sube quien lo pide. */
async function encodeXVideo(
  path: string,
  source: Probe,
  musicPath: string | null,
  options: VideoToolOptions,
  signal?: AbortSignalLike,
): Promise<VideoOutput> {
  const outPath = join(options.workDir, `${randomUUID()}-x.mp4`);
  // La duración completa (el límite de X lo revisa quien publica, T16).
  const { fps, x264, audio } = X_VIDEO_SPEC;
  const size = xVideoSize(source);
  const threads = options.threads === undefined ? null : String(options.threads);
  const argsFor = (music: string | null) => {
    const streams = reducedStreams(
      path,
      source,
      `fps=${fps},scale=${size.width}:${size.height},format=yuv420p,setsar=1`,
      music,
      threads,
    );
    return [
      ...["-hide_banner", "-loglevel", "error", "-nostdin", "-y"],
      ...streams.args,
      ...["-r", String(fps)],
      ...[
        "-c:v",
        "libx264",
        "-preset",
        x264.preset,
        "-profile:v",
        "high",
        "-crf",
        String(x264.crf),
      ],
      ...(threads === null ? [] : ["-threads", threads]),
      ...["-maxrate", x264.maxrate, "-bufsize", x264.bufsize],
      ...["-g", String(x264.gop), "-keyint_min", String(x264.gop), "-sc_threshold", "0"],
      ...["-flags", "+cgop"],
      ...(streams.withAudio
        ? ["-c:a", "aac", "-b:a", audio.bitrate, "-ac", "2", "-ar", String(audio.sampleRate)]
        : ["-an"]),
      ...["-movflags", "+faststart", "-map_metadata", "-1", outPath],
    ];
  };
  let withoutMusic: boolean;
  try {
    withoutMusic = await withMusicFallback(musicPath, (music) =>
      runOrDecodeFailed(options.ffmpegPath, argsFor(music), signal),
    );
  } catch (error) {
    await rm(outPath, { force: true });
    throw error;
  }
  return markedOutput(await outputOf(outPath, options, signal), withoutMusic);
}

/**
 * Arma el video liviano para Discord en el temporal (`DISCORD_VIDEO_SPEC`, D8 de F9.5) bajo
 * `maxBytes`; lo sube quien lo pide. `null` sin codificar si el bitrate quedaría bajo el mínimo, o
 * si el resultado igual pasa del tope (se borra).
 */
async function encodeDiscordVideo(
  path: string,
  source: Probe,
  maxBytes: number,
  musicPath: string | null,
  options: VideoToolOptions,
  signal?: AbortSignalLike,
): Promise<VideoOutput | null> {
  const kbps = discordVideoBitrateKbps({
    durationS: source.durationS,
    // Con música siempre lleva audio (F9.5-T19).
    hasAudio: source.hasAudio || musicPath !== null,
    maxBytes,
  });
  if (kbps === null) return null;
  const outPath = join(options.workDir, `${randomUUID()}-discord.mp4`);
  const { fps, x264, audio, bufferS } = DISCORD_VIDEO_SPEC;
  const size = discordVideoSize(source);
  const threads = options.threads === undefined ? null : String(options.threads);
  const rate = `${kbps}k`;
  const argsFor = (music: string | null) => {
    const streams = reducedStreams(
      path,
      source,
      `fps=${fps},scale=${size.width}:${size.height},format=yuv420p,setsar=1`,
      music,
      threads,
    );
    return [
      ...["-hide_banner", "-loglevel", "error", "-nostdin", "-y"],
      ...streams.args,
      ...["-r", String(fps)],
      ...["-c:v", "libx264", "-preset", x264.preset, "-profile:v", "high"],
      ...(threads === null ? [] : ["-threads", threads]),
      // Bitrate medio = tope, con un búfer de `bufferS` segundos: el VBV acota el peso del video.
      ...["-b:v", rate, "-maxrate", rate, "-bufsize", `${Math.round(kbps * bufferS)}k`],
      ...["-g", String(x264.gop), "-keyint_min", String(x264.gop), "-sc_threshold", "0"],
      ...["-flags", "+cgop"],
      ...(streams.withAudio
        ? ["-c:a", "aac", "-b:a", `${audio.kbps}k`, "-ac", "2", "-ar", String(audio.sampleRate)]
        : ["-an"]),
      ...["-movflags", "+faststart", "-map_metadata", "-1", outPath],
    ];
  };
  let withoutMusic: boolean;
  try {
    withoutMusic = await withMusicFallback(musicPath, (music) =>
      runOrDecodeFailed(options.ffmpegPath, argsFor(music), signal),
    );
  } catch (error) {
    await rm(outPath, { force: true });
    throw error;
  }
  // Se mide: si igual pasó del tope, no sirve (Discord lo rechazaría).
  if ((await stat(outPath)).size > maxBytes) {
    await rm(outPath, { force: true });
    return null;
  }
  return markedOutput(await outputOf(outPath, options, signal), withoutMusic);
}

/**
 * Un video → sus medidas, su `thumb` y, con `reel`, el reel de Instagram (spec F2 §4.2, D5); con
 * `xVideo`, el video reducido para X (spec F9 §4.5). Un video de menos de 3 s no da reel (sí video
 * para X, desde 0,5 s); el reel de uno de más de 90 s se corta (los avisos son de core), y el video
 * para X sale entero. Con `discordVideo`, el video liviano para Discord bajo su tope (F9.5 D8), o
 * `null` si no se puede. Con `music` (F9.5-T19), todos esos videos llevan la música de fondo
 * (`MUSIC_SPEC`: detrás del sonido del video, o sola). Todo queda en el temporal del intento, que
 * el worker borra al terminar (los videos también: se suben antes con `open()`).
 */
export async function processVideo(
  input: AsyncIterable<Uint8Array>,
  { reel, xVideo = false, discordVideo = null, music = null }: VideoProcessOptions,
  options: VideoToolOptions,
  signal?: AbortSignalLike,
): Promise<ProcessedVideo> {
  throwIfAborted(signal);
  await options.ensureTools(signal);
  const path = join(options.workDir, `${randomUUID()}-video`);
  let musicPath: string | null = null;
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

    // La música (F9.5-T19) va en todo lo que se arme en esta pasada: el reel, X y Discord.
    if (music !== null && (reel !== null || xVideo || discordVideo !== null)) {
      musicPath = await writeMusic(music, options);
    }
    // Sin reel bajo el mínimo de Meta; el aviso lo calcula core (`reelWarnings`).
    const output =
      reel === null || source.durationS < REEL_MIN_DURATION_S
        ? null
        : await encodeReel(path, source, reel.overlayPng, musicPath, options, signal);
    const forX =
      !xVideo || source.durationS < X_VIDEO_MIN_DURATION_S
        ? null
        : await encodeXVideo(path, source, musicPath, options, signal);
    const forDiscord =
      discordVideo === null
        ? null
        : await encodeDiscordVideo(path, source, discordVideo.maxBytes, musicPath, options, signal);
    return {
      measurements: { width: source.width, height: source.height, durationS: source.durationS },
      thumb,
      reel: output,
      xVideo: forX,
      discordVideo: forDiscord,
    };
  } finally {
    await rm(path, { force: true });
    if (musicPath !== null) await rm(musicPath, { force: true });
  }
}
