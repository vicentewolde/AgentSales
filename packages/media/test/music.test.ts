import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MusicInput } from "@agentsales/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMediaProcessor, MUSIC_SPEC, PHOTO_REEL_SPEC } from "../src/index.js";
import { musicAudioFilter } from "../src/video.js";
import { FFMPEG, FFPROBE, syntheticPhoto, TEST_THREADS } from "./images.js";

// La música de los reels (F9.5-T19), con ffmpeg de verdad: la «voz» del video es un tono de 300 Hz
// y la «música» uno de 2400 Hz, los dos al mismo nivel de origen; así se mide cada uno con un
// filtro de banda. La pista dura 2,5 s (menos que los videos de 6 s): también prueba el bucle.

const VOICE_HZ = 300;
const MUSIC_HZ = 2400;
const VIDEO_S = 6;

let dir: string;
let music: MusicInput;
const videos: Record<string, string> = {};

const ffmpeg = (args: string[]) => execFileSync(FFMPEG, ["-v", "error", "-y", ...args]);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentsales-music-test-"));
  const make = (name: string, audio: boolean) => {
    const path = join(dir, `${name}.mp4`);
    // biome-ignore format: un argumento por opción
    ffmpeg([
      "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10",
      ...(audio ? ["-f", "lavfi", "-i", `sine=frequency=${VOICE_HZ}:sample_rate=48000`] : []),
      "-t", String(VIDEO_S), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      ...(audio ? ["-c:a", "aac", "-shortest"] : []),
      path,
    ]);
    videos[name] = path;
  };
  make("conVoz", true);
  make("sinAudio", false);
  // La pista: AAC en m4a (el procesador no mira la extensión: ffmpeg lee el contenido).
  const track = join(dir, "pista.m4a");
  // biome-ignore format: un argumento por opción
  ffmpeg([
    "-f", "lavfi", "-i", `sine=frequency=${MUSIC_HZ}:sample_rate=48000`,
    "-t", "2.5", "-c:a", "aac", "-b:a", "128k", track,
  ]);
  music = { bytes: new Uint8Array(await readFile(track)) };
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function* fileStream(path: string): AsyncIterable<Uint8Array> {
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    yield chunk as Uint8Array;
  }
}

const video = (name: string) => fileStream(videos[name] ?? "");

const processor = async (workDir?: string) =>
  createMediaProcessor({
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    workDir: workDir ?? (await mkdtemp(join(dir, "intento-"))),
    threads: TEST_THREADS,
  });

async function save(open: () => AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of open()) chunks.push(chunk);
  const path = join(dir, `salida-${randomUUID()}.mp4`);
  await writeFile(path, Buffer.concat(chunks));
  return path;
}

/** Las pistas del archivo según ffprobe. */
function streams(path: string) {
  const output = execFileSync(FFPROBE, [
    ...["-v", "error", "-print_format", "json", "-show_streams", path],
  ]);
  return (
    JSON.parse(output.toString()) as {
      streams: { codec_type: string; codec_name: string; duration?: string; channels?: number }[];
    }
  ).streams;
}

/**
 * El nivel medio (dB) de una frecuencia en un tramo del audio: un filtro de banda angosto y
 * `volumedetect`. Un tramo en silencio da alrededor de −91 dB.
 */
function bandLevel(path: string, hz: number, fromS: number, durationS: number): number {
  // Dos pasadas del filtro: el otro tono queda unos 40 dB más abajo.
  const band = `bandpass=f=${hz}:width_type=q:w=4`;
  const run = spawnSync(FFMPEG, [
    ...["-hide_banner", "-nostats", "-ss", fromS.toFixed(3), "-t", durationS.toFixed(3)],
    ...["-i", path, "-vn", "-af", `${band},${band},volumedetect`],
    ...["-f", "null", "-"],
  ]);
  const match = /mean_volume: (-?[\d.]+) dB/.exec(run.stderr.toString());
  if (match === null) throw new Error(`sin nivel: ${run.stderr.toString()}`);
  return Number(match[1]);
}

const durations = (path: string) => {
  const all = streams(path);
  return {
    video: Number(all.find((stream) => stream.codec_type === "video")?.duration),
    audio: Number(all.find((stream) => stream.codec_type === "audio")?.duration),
  };
};

describe("musicAudioFilter", () => {
  it("sin sonido propio, la música sola; con sonido, mezclada detrás sin normalizar", () => {
    const alone = musicAudioFilter(null, 1, 6);
    expect(alone).toContain("[1:a:0]");
    expect(alone).toContain(`volume=${MUSIC_SPEC.aloneDb}dB`);
    expect(alone).toContain("afade=t=out:st=4.000:d=2.000");
    expect(alone.endsWith("[a]")).toBe(true);
    expect(alone).not.toContain("amix");
    const mixed = musicAudioFilter("0:a:0", 2, 6);
    expect(mixed).toContain(`volume=${MUSIC_SPEC.underVoiceDb}dB`);
    expect(mixed).toContain("[0:a:0]");
    expect(mixed).toContain("amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]");
    // Un video corto: el fundido de salida es como mucho un tercio.
    expect(musicAudioFilter(null, 1, 3)).toContain("afade=t=out:st=2.000:d=1.000");
  });
});

describe("processVideo con música (F9.5-T19)", () => {
  it("un video con voz: la voz al frente, la música detrás y más baja, con fundido final", async () => {
    const result = await (await processor()).processVideo(video("conVoz"), {
      reel: { overlayPng: null },
      music,
    });
    if (result.reel === null) throw new Error("falta el reel");
    const path = await save(result.reel.open);
    const plain = await (await processor()).processVideo(video("conVoz"), {
      reel: { overlayPng: null },
    });
    if (plain.reel === null) throw new Error("falta el reel sin música");
    const plainPath = await save(plain.reel.open);

    // El audio dura lo que el video.
    const { video: videoS, audio: audioS } = durations(path);
    expect(Math.abs(audioS - videoS)).toBeLessThan(0.1);
    expect(Math.abs(videoS - VIDEO_S)).toBeLessThan(0.1);

    // En el medio: la voz como sin música, y la música bastante más baja que la voz.
    const voice = bandLevel(path, VOICE_HZ, 2, 1.5);
    const voicePlain = bandLevel(plainPath, VOICE_HZ, 2, 1.5);
    const musicMid = bandLevel(path, MUSIC_HZ, 2, 1.5);
    expect(Math.abs(voice - voicePlain)).toBeLessThan(1.5);
    expect(voice - musicMid).toBeGreaterThan(12);
    // Sin música no hay nada en esa banda.
    expect(bandLevel(plainPath, MUSIC_HZ, 2, 1.5)).toBeLessThan(musicMid - 20);
    // Pasado el largo de la pista (2,5 s), sigue sonando: se repite.
    expect(Math.abs(bandLevel(path, MUSIC_HZ, 3.2, 1) - musicMid)).toBeLessThan(3);
    // Al final, el fundido: la música baja y la voz no.
    expect(bandLevel(path, MUSIC_HZ, VIDEO_S - 0.4, 0.35)).toBeLessThan(musicMid - 8);
    expect(Math.abs(bandLevel(path, VOICE_HZ, VIDEO_S - 0.4, 0.35) - voice)).toBeLessThan(2);
  }, 90_000);

  it("un video sin sonido: la música sola (más fuerte que detrás de una voz), con fundido", async () => {
    const result = await (await processor()).processVideo(video("sinAudio"), {
      reel: { overlayPng: null },
      music,
    });
    if (result.reel === null) throw new Error("falta el reel");
    const path = await save(result.reel.open);
    const audio = streams(path).find((stream) => stream.codec_type === "audio");
    expect(audio).toMatchObject({ codec_name: "aac", channels: 2 });
    const { video: videoS, audio: audioS } = durations(path);
    expect(Math.abs(audioS - videoS)).toBeLessThan(0.1);
    // La pista de origen está cerca de −21 dB: sola baja `aloneDb` (−3), no los −18 de detrás de
    // una voz.
    const middle = bandLevel(path, MUSIC_HZ, 2, 1.5);
    expect(middle).toBeGreaterThan(-30);
    expect(bandLevel(path, MUSIC_HZ, VIDEO_S - 0.4, 0.35)).toBeLessThan(middle - 8);
  }, 90_000);

  it("el video para X y el de Discord también llevan la música, con la duración del video", async () => {
    const work = await mkdtemp(join(dir, "intento-"));
    const result = await (await processor(work)).processVideo(video("sinAudio"), {
      reel: null,
      xVideo: true,
      discordVideo: { maxBytes: 2_000_000 },
      music,
    });
    for (const output of [result.xVideo, result.discordVideo]) {
      if (output === null) throw new Error("falta un video");
      const path = await save(output.open);
      const { video: videoS, audio: audioS } = durations(path);
      expect(Math.abs(audioS - videoS)).toBeLessThan(0.15);
      expect(Math.abs(videoS - VIDEO_S)).toBeLessThan(0.15);
      expect(bandLevel(path, MUSIC_HZ, 2, 1.5)).toBeGreaterThan(-40);
    }
    // La pista y la copia del video se borran; quedan solo los dos videos para subir.
    expect((await readdir(work)).filter((name) => name.includes("musica"))).toEqual([]);
  }, 90_000);
});

describe("X y Discord con voz y música (F9.5-T19)", () => {
  it("la voz al frente y la música detrás, más baja, con la duración del video", async () => {
    const result = await (await processor()).processVideo(video("conVoz"), {
      reel: null,
      xVideo: true,
      discordVideo: { maxBytes: 2_000_000 },
      music,
    });
    for (const output of [result.xVideo, result.discordVideo]) {
      if (output === null) throw new Error("falta un video");
      expect(output.withoutMusic).toBeUndefined();
      const path = await save(output.open);
      const { video: videoS, audio: audioS } = durations(path);
      expect(Math.abs(audioS - videoS)).toBeLessThan(0.15);
      const voice = bandLevel(path, VOICE_HZ, 2, 1.5);
      const musicMid = bandLevel(path, MUSIC_HZ, 2, 1.5);
      expect(voice).toBeGreaterThan(-35);
      expect(voice - musicMid).toBeGreaterThan(12);
      expect(musicMid).toBeGreaterThan(-75);
    }
  }, 90_000);
});

describe("una pista que ffmpeg no puede leer (F9.5-T19)", () => {
  it("el reel, X, Discord y el reel con fotos salen igual, sin música y marcados", async () => {
    // La cabecera de un MP3 y después basura: pasa por MP3, pero ffmpeg no la decodifica.
    const broken = {
      bytes: Uint8Array.from([
        0x49,
        0x44,
        0x33,
        4,
        0,
        0,
        0,
        0,
        0,
        0,
        ...Array.from({ length: 4000 }, (_, index) => index % 7),
      ]),
    };
    const work = await mkdtemp(join(dir, "intento-"));
    const result = await (await processor(work)).processVideo(video("conVoz"), {
      reel: { overlayPng: null },
      xVideo: true,
      discordVideo: { maxBytes: 2_000_000 },
      music: broken,
    });
    for (const output of [result.reel, result.xVideo, result.discordVideo]) {
      if (output === null) throw new Error("falta un video");
      expect(output.withoutMusic).toBe(true);
      const path = await save(output.open);
      // El sonido propio del video sigue ahí.
      expect(bandLevel(path, VOICE_HZ, 2, 1.5)).toBeGreaterThan(-35);
    }
    const photos = await Promise.all([
      syntheticPhoto(900, 1600),
      syntheticPhoto(1600, 900),
      syntheticPhoto(1200, 1200),
    ]);
    const reel = await (await processor(work)).processPhotoReel(
      photos.map((bytes) => ({ mime: "image/jpeg", read: async () => bytes })),
      { overlayPng: null, music: broken },
    );
    expect(reel.withoutMusic).toBe(true);
    const path = await save(reel.open);
    expect(streams(path).find((stream) => stream.codec_type === "audio")).toMatchObject({
      codec_name: "aac",
    });
    expect((await readdir(work)).filter((name) => name.includes("musica"))).toEqual([]);
  }, 120_000);
});

describe("processPhotoReel con música (F9.5-T19)", () => {
  it("el reel con fotos lleva la música sola en vez del silencio, del largo del reel", async () => {
    const photos = await Promise.all([
      syntheticPhoto(900, 1600),
      syntheticPhoto(1600, 900),
      syntheticPhoto(1200, 1200),
    ]);
    const work = await mkdtemp(join(dir, "intento-"));
    const reel = await (await processor(work)).processPhotoReel(
      photos.map((bytes) => ({ mime: "image/jpeg", read: async () => bytes })),
      { overlayPng: null, music },
    );
    const path = await save(reel.open);
    const expected = photos.length * PHOTO_REEL_SPEC.slideS;
    const { video: videoS, audio: audioS } = durations(path);
    expect(Math.abs(videoS - expected)).toBeLessThan(0.15);
    expect(Math.abs(audioS - videoS)).toBeLessThan(0.15);
    const middle = bandLevel(path, MUSIC_HZ, 3, 2);
    expect(middle).toBeGreaterThan(-40);
    expect(bandLevel(path, MUSIC_HZ, expected - 0.4, 0.35)).toBeLessThan(middle - 8);
    expect((await readdir(work)).filter((name) => name.includes("musica"))).toEqual([]);
  }, 90_000);
});
