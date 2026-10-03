import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMediaProcessor, REEL_SPEC } from "../src/index.js";
import { alive, errorOf, FFMPEG, FFPROBE, fakeFfmpeg, TEST_THREADS, waitFor } from "./images.js";

// Videos generados con ffmpeg (`testsrc`, `color` y `sine`; spec F2-T08), sin archivos de clientes.
// Chicos y a pocos cuadros por segundo, para que generarlos sea rápido; el reel sí es de verdad.

let dir: string;
const videos: Record<string, string> = {};
let overlayPng: Uint8Array;

const ffmpeg = (args: string[]) => execFileSync(FFMPEG, ["-v", "error", "-y", ...args]);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentsales-video-test-"));
  const make = (name: string, source: string, seconds: number, audio: boolean) => {
    const path = join(dir, `${name}.mp4`);
    // biome-ignore format: un argumento por opción
    ffmpeg([
      "-f", "lavfi", "-i", `${source}:rate=10`,
      ...(audio ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"] : []),
      "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      ...(audio ? ["-c:a", "aac", "-shortest"] : []),
      path,
    ]);
    videos[name] = path;
  };
  make("horizontal", "testsrc=size=640x360", 4, true);
  make("vertical", "testsrc=size=360x640", 4, true);
  make("sinAudio", "testsrc=size=640x360", 4, false);
  make("largo", "testsrc=size=160x90", 100, true);
  make("corto", "testsrc=size=640x360", 2, true);
  make("doce", "testsrc=size=320x180", 12, true);
  make("azul", "color=c=blue:size=640x360", 5, false);
  // Un video horizontal grabado con el celular girado: la matriz dice 90°.
  videos.girado = join(dir, "girado.mp4");
  ffmpeg([
    "-display_rotation:v:0",
    "90",
    "-i",
    videos.horizontal ?? "",
    "-c",
    "copy",
    videos.girado,
  ]);

  // El texto del reel: transparente, con una franja verde arriba (como lo entregaría el render).
  const band = await sharp({
    create: { width: 1080, height: 300, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
  overlayPng = new Uint8Array(
    await sharp({
      create: {
        width: 1080,
        height: 1920,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: band, top: 0, left: 0 }])
      .png()
      .toBuffer(),
  );
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function* fileStream(path: string): AsyncIterable<Uint8Array> {
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    yield chunk as Uint8Array;
  }
}

const video = (name: string) => fileStream(videos[name] ?? "");

async function workDir(): Promise<string> {
  return mkdtemp(join(dir, "intento-"));
}

const processor = async (overrides: { ffmpegPath?: string; ffprobePath?: string } = {}) =>
  createMediaProcessor({
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    workDir: await workDir(),
    threads: TEST_THREADS,
    ...overrides,
  });

/** Lo que dice ffprobe del reel. */
function probeFile(path: string) {
  const output = execFileSync(FFPROBE, [
    ...["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path],
  ]);
  return JSON.parse(output.toString()) as {
    streams: Record<string, string | number | undefined>[];
    format: { duration: string; bit_rate: string };
  };
}

/** Escribe el reel a un archivo (con `open()`, como lo subiría la corrida). */
async function saveReel(
  open: () => AsyncIterable<Uint8Array>,
): Promise<{ path: string; bytes: Buffer }> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of open()) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const path = join(dir, `reel-${randomUUID()}.mp4`);
  await writeFile(path, bytes);
  return { path, bytes };
}

/** El color de un píxel de un cuadro del video en el segundo `atS` (el cuadro sale en PNG). */
async function framePixel(path: string, atS: number, x: number, y: number): Promise<number[]> {
  const png = execFileSync(FFMPEG, [
    ...["-v", "error", "-ss", String(atS), "-i", path, "-frames:v", "1"],
    ...["-f", "image2pipe", "-c:v", "png", "pipe:1"],
  ]);
  const data = await sharp(png).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer();
  return [...data].slice(0, 3);
}

describe("processVideo: medidas y thumb", () => {
  it("mide un video horizontal y saca su thumb, sin reel si no se pide", async () => {
    const result = await (await processor()).processVideo(video("horizontal"), { reel: null });

    expect(result.measurements).toMatchObject({ width: 640, height: 360 });
    expect(result.measurements.durationS).toBeCloseTo(4, 1);
    expect(result.reel).toBeNull();
    expect(result.thumb).toMatchObject({
      variant: "thumb",
      width: 640,
      height: 360,
      mime: "image/jpeg",
    });
    const metadata = await sharp(result.thumb.bytes).metadata();
    expect([metadata.format, metadata.exif]).toEqual(["jpeg", undefined]);
    expect(result.thumb.sha256).toBe(createHash("sha256").update(result.thumb.bytes).digest("hex"));
  });

  it("un video grabado girado se mide derecho, y su thumb también", async () => {
    const result = await (await processor()).processVideo(video("girado"), { reel: null });

    expect(result.measurements).toMatchObject({ width: 360, height: 640 });
    expect([result.thumb.width, result.thumb.height]).toEqual([360, 640]);
  });

  it("un archivo que no es un video → MEDIA_DECODE_FAILED, sin dejar temporales", async () => {
    const work = await workDir();
    const broken = createMediaProcessor({
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      workDir: work,
    });
    async function* garbage() {
      yield new TextEncoder().encode("no soy un video");
    }

    const error = await errorOf(broken.processVideo(garbage(), { reel: null }));
    expect([error.code, error.retriable]).toEqual(["MEDIA_DECODE_FAILED", false]);
    expect(await readdir(work)).toEqual([]);
  });
});

describe("processVideo: reel", () => {
  it("1080×1920 en H.264 4:2:0 a 30 fps con AAC, moov al inicio, sin edit lists, GOP cerrado y bajo 25 Mbps", async () => {
    const result = await (await processor()).processVideo(video("horizontal"), {
      reel: { overlayPng },
    });
    const reel = result.reel;
    if (reel === null) throw new Error("falta el reel");
    const { path, bytes } = await saveReel(reel.open);
    const info = probeFile(path);
    const videoStream = info.streams.find((stream) => stream.codec_type === "video");
    const audioStream = info.streams.find((stream) => stream.codec_type === "audio");

    expect(videoStream).toMatchObject({
      codec_name: "h264",
      pix_fmt: "yuv420p",
      width: 1080,
      height: 1920,
      r_frame_rate: "30/1",
    });
    expect(audioStream).toMatchObject({ codec_name: "aac", channels: 2 });
    expect(Number(info.format.bit_rate)).toBeLessThan(25_000_000);
    expect(bytes.indexOf("moov")).toBeLessThan(bytes.indexOf("mdat"));
    expect(bytes.indexOf("elst")).toBe(-1);
    // x264 deja sus opciones en el archivo: GOP cerrado (el espaciado se prueba con ffprobe abajo).
    expect(bytes.toString("latin1")).toContain("open_gop=0");
    expect({
      size: reel.size,
      sha256: reel.sha256,
      width: reel.width,
      height: reel.height,
    }).toEqual({
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: 1080,
      height: 1920,
    });
    // El contenedor dura lo que la pista más larga: el AAC puede pasarse unas centésimas.
    expect(reel.durationS).toBeGreaterThan(3.9);
    expect(reel.durationS).toBeLessThan(4.2);
  }, 60_000);

  it("un cuadro clave cada 2 s exactos (GOP fijo, leído con ffprobe)", async () => {
    const result = await (await processor()).processVideo(video("doce"), { reel: { overlayPng } });
    if (result.reel === null) throw new Error("falta el reel");
    const { path } = await saveReel(result.reel.open);
    const keyframes = execFileSync(FFPROBE, [
      ...["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey"],
      ...["-show_entries", "frame=pts_time", "-of", "csv=p=0", path],
    ])
      .toString()
      .trim()
      .split("\n")
      // Algunas líneas traen una coma al final (datos laterales del cuadro).
      .map((line) => Number.parseFloat(line));

    expect(keyframes).toHaveLength(6);
    const gapS = REEL_SPEC.x264.gop / REEL_SPEC.fps;
    for (let i = 1; i < keyframes.length; i += 1) {
      expect((keyframes[i] ?? 0) - (keyframes[i - 1] ?? 0)).toBeCloseTo(gapS, 2);
    }
  }, 60_000);

  it("el texto va encima los primeros 2 s y después no", async () => {
    const result = await (await processor()).processVideo(video("azul"), { reel: { overlayPng } });
    if (result.reel === null) throw new Error("falta el reel");
    const { path } = await saveReel(result.reel.open);

    const [r0 = 0, g0 = 0, b0 = 0] = await framePixel(path, 0.5, 540, 100);
    const [r3 = 0, g3 = 0, b3 = 0] = await framePixel(path, 3, 540, 100);
    expect(g0).toBeGreaterThan(200);
    expect(Math.max(r0, b0)).toBeLessThan(60);
    expect(b3).toBeGreaterThan(200);
    expect(Math.max(r3, g3)).toBeLessThan(60);
  }, 60_000);

  it("un video vertical también sale en 1080×1920", async () => {
    const result = await (await processor()).processVideo(video("vertical"), {
      reel: { overlayPng },
    });
    expect([result.reel?.width, result.reel?.height]).toEqual([1080, 1920]);
  }, 60_000);

  it("un video sin audio recibe una pista AAC silenciosa", async () => {
    const result = await (await processor()).processVideo(video("sinAudio"), {
      reel: { overlayPng },
    });
    if (result.reel === null) throw new Error("falta el reel");
    const { path } = await saveReel(result.reel.open);
    const audioStream = probeFile(path).streams.find((stream) => stream.codec_type === "audio");
    expect(audioStream).toMatchObject({ codec_name: "aac" });
    expect(Number(audioStream?.duration)).toBeGreaterThan(3.5);
  }, 60_000);

  it("un video de 100 s se corta a 90 s (el aviso lo calcula core: reelWarnings)", async () => {
    const result = await (await processor()).processVideo(video("largo"), { reel: { overlayPng } });

    expect(result.measurements.durationS).toBeCloseTo(100, 0);
    expect(result.reel?.durationS).toBeGreaterThan(89.5);
    expect(result.reel?.durationS).toBeLessThanOrEqual(90.2);
  }, 240_000);

  it("un video de 2 s no da reel, pero sí medidas y thumb", async () => {
    const withReel = await (await processor()).processVideo(video("corto"), {
      reel: { overlayPng },
    });
    const withoutReel = await (await processor()).processVideo(video("corto"), { reel: null });

    expect(withReel.reel).toBeNull();
    expect(withReel.thumb.variant).toBe("thumb");
    expect(withReel.measurements.durationS).toBeCloseTo(2, 0);
    expect(withoutReel.reel).toBeNull();
  });

  it("solo el reel queda en el temporal (para subirlo); la copia del video y el texto se borran", async () => {
    const work = await workDir();
    const result = await createMediaProcessor({
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      workDir: work,
      threads: TEST_THREADS,
    }).processVideo(video("horizontal"), { reel: { overlayPng } });

    const files = await readdir(work);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-reel\.mp4$/);
    expect((await readFile(join(work, files[0] ?? ""))).length).toBe(result.reel?.size);
  }, 60_000);
});

describe("processVideo: herramientas y corte", () => {
  it.each([
    ["FFMPEG_PATH", { ffmpegPath: "/no/existe/ffmpeg" }],
    ["FFPROBE_PATH", { ffprobePath: "/no/existe/ffprobe" }],
  ])("un %s que no existe → MEDIA_TOOL_NOT_INSTALLED", async (_, overrides) => {
    const error = await errorOf(
      (await processor(overrides)).processVideo(video("horizontal"), { reel: null }),
    );
    expect([error.code, error.retriable]).toEqual(["MEDIA_TOOL_NOT_INSTALLED", false]);
  });

  it("cortar mientras ffmpeg trabaja lo termina: MEDIA_ABORTED, reintentable", async () => {
    const fake = await fakeFfmpeg("9.0.1");
    const controller = new AbortController();
    const pending = (await processor({ ffmpegPath: fake.path })).processVideo(
      video("horizontal"),
      { reel: null },
      controller.signal,
    );
    const pid = await waitFor(async () => {
      const value = Number(await readFile(join(fake.dir, "pid"), "utf8"));
      return Number.isInteger(value) && value > 0 ? value : undefined;
    });
    controller.abort();

    const error = await errorOf(pending);
    expect([error.code, error.retriable]).toEqual(["MEDIA_ABORTED", true]);
    await waitFor(async () => (alive(pid) ? undefined : true));
    await rm(fake.dir, { recursive: true, force: true });
  });
});
