import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReelPhotoInput } from "@agentsales/core";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMediaProcessor, PHOTO_REEL_SPEC, REEL_SPEC } from "../src/index.js";
import {
  errorOf,
  FFMPEG,
  FFPROBE,
  HEIC_FIXTURE,
  isRed,
  syntheticPhoto,
  TEST_THREADS,
} from "./images.js";

// El reel armado con fotos (F9.5-T18): fotos sintéticas (un degradado con un bloque rojo arriba a
// la izquierda), sin archivos de clientes. El reel sí es de verdad (ffmpeg y ffprobe).

let dir: string;
let overlayPng: Uint8Array;
let horizontal: Uint8Array;
let vertical: Uint8Array;
let square: Uint8Array;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentsales-photo-reel-test-"));
  horizontal = await syntheticPhoto(1600, 900);
  vertical = await syntheticPhoto(900, 1600);
  square = await syntheticPhoto(1200, 1200, { format: "png" });
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
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const photo = (bytes: Uint8Array, mime = "image/jpeg"): ReelPhotoInput => ({
  mime,
  read: async () => bytes,
});

const processor = async (work?: string) =>
  createMediaProcessor({
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    workDir: work ?? (await mkdtemp(join(dir, "intento-"))),
    threads: TEST_THREADS,
  });

async function saveReel(open: () => AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of open()) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const path = join(dir, `reel-${randomUUID()}.mp4`);
  await writeFile(path, bytes);
  return { path, bytes };
}

function probeFile(path: string) {
  const output = execFileSync(FFPROBE, [
    ...["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path],
  ]);
  return JSON.parse(output.toString()) as {
    streams: Record<string, string | number | undefined>[];
    format: { duration: string; bit_rate: string };
  };
}

async function framePixel(path: string, atS: number, x: number, y: number): Promise<number[]> {
  const png = execFileSync(FFMPEG, [
    ...["-v", "error", "-ss", String(atS), "-i", path, "-frames:v", "1"],
    ...["-f", "image2pipe", "-c:v", "png", "pipe:1"],
  ]);
  const data = await sharp(png).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer();
  return [...data].slice(0, 3);
}

describe("processPhotoReel (F9.5-T18)", () => {
  it("3 fotos → 1080×1920 en H.264 a 30 fps, 3 s por foto, con audio AAC silencioso y moov al inicio", async () => {
    const reel = await (await processor()).processPhotoReel(
      [photo(horizontal), photo(vertical), photo(square, "image/png")],
      { overlayPng },
    );
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
    expect(audioStream).toMatchObject({ codec_name: "aac", channels: 2, sample_rate: "48000" });
    const expectedS = 3 * PHOTO_REEL_SPEC.slideS;
    expect(Number(videoStream?.duration)).toBeCloseTo(expectedS, 1);
    expect(Number(audioStream?.duration)).toBeGreaterThan(expectedS - 0.2);
    expect(reel.durationS).toBeGreaterThan(expectedS - 0.1);
    expect(reel.durationS).toBeLessThan(expectedS + 0.2);
    expect(bytes.indexOf("moov")).toBeLessThan(bytes.indexOf("mdat"));
    expect(bytes.indexOf("elst")).toBe(-1);
    expect(Number(info.format.bit_rate)).toBeLessThan(25_000_000);
    expect({
      size: reel.size,
      sha256: reel.sha256,
      width: reel.width,
      height: reel.height,
    }).toEqual({
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: REEL_SPEC.width,
      height: REEL_SPEC.height,
    });
  }, 90_000);

  it("las fotos van en orden, enteras al centro sobre su fondo difuminado, y el texto solo los primeros 2 s", async () => {
    const reel = await (await processor()).processPhotoReel(
      [photo(horizontal), photo(vertical), photo(horizontal)],
      { overlayPng },
    );
    const { path } = await saveReel(reel.open);

    // Segundo 1: la franja verde del texto arriba; la foto horizontal (1080×608) al centro, con su
    // bloque rojo en la esquina (y = 656 a 808); abajo, el fondo difuminado (ni negro ni rojo).
    const [r0 = 0, g0 = 0, b0 = 0] = await framePixel(path, 1, 540, 100);
    expect(g0).toBeGreaterThan(200);
    expect(Math.max(r0, b0)).toBeLessThan(60);
    expect(isRed(await framePixel(path, 1, 100, 700))).toBe(true);
    const background = await framePixel(path, 1, 540, 1750);
    expect(Math.max(...background)).toBeGreaterThan(40);
    expect(isRed(background)).toBe(false);

    // Segundo 4,5: la foto vertical llena el cuadro (su bloque rojo arriba a la izquierda) y el
    // texto ya no está.
    expect(isRed(await framePixel(path, 4.5, 100, 100))).toBe(true);
    const [, g4 = 0] = await framePixel(path, 4.5, 540, 100);
    expect(g4).toBeLessThan(200);
  }, 90_000);

  it("sin texto, también sale; un HEIC del iPhone sirve como foto", async () => {
    const heic = new Uint8Array(await readFile(HEIC_FIXTURE));
    const reel = await (await processor()).processPhotoReel(
      [photo(heic, "image/heic"), photo(vertical), photo(square, "image/png")],
      { overlayPng: null },
    );
    expect([reel.width, reel.height]).toEqual([1080, 1920]);
    expect(reel.durationS).toBeGreaterThan(8.9);
  }, 90_000);

  it("menos de 3 o más de 10 fotos → MEDIA_REEL_PHOTOS_INVALID, sin llamar a ffmpeg", async () => {
    const two = await errorOf(
      (await processor()).processPhotoReel([photo(horizontal), photo(vertical)], { overlayPng }),
    );
    const eleven = await errorOf(
      (await processor()).processPhotoReel(
        Array.from({ length: 11 }, () => photo(horizontal)),
        { overlayPng },
      ),
    );
    expect(two).toMatchObject({ code: "MEDIA_REEL_PHOTOS_INVALID", retriable: false });
    expect(eleven).toMatchObject({ code: "MEDIA_REEL_PHOTOS_INVALID" });
  });

  it("una foto ilegible → MEDIA_DECODE_FAILED, sin dejar nada en el temporal", async () => {
    const work = await mkdtemp(join(dir, "intento-"));
    const error = await errorOf(
      (await processor(work)).processPhotoReel(
        [photo(horizontal), photo(new TextEncoder().encode("no es una foto")), photo(vertical)],
        { overlayPng },
      ),
    );
    expect(error.code).toBe("MEDIA_DECODE_FAILED");
    expect(await readdir(work)).toEqual([]);
  });

  it("solo el reel queda en el temporal (para subirlo); los cuadros y el texto se borran", async () => {
    const work = await mkdtemp(join(dir, "intento-"));
    const reel = await (await processor(work)).processPhotoReel(
      [photo(horizontal), photo(vertical), photo(square, "image/png")],
      { overlayPng },
    );
    const files = await readdir(work);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-reel\.mp4$/);
    expect((await readFile(join(work, files[0] ?? ""))).length).toBe(reel.size);
  }, 90_000);
});
