import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MUSIC_TRACK_IDS } from "@agentsales/core";
import { createInMemoryMediaStorage } from "@agentsales/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ffmpegDecodes, looksLikeMp3, musicUploadText, uploadMusicFolder } from "./music-upload.js";

/** En estos tests ffmpeg "lee" todo, salvo lo que diga el test. */
const decodesAll = async () => true;
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";

/** Un "MP3" mínimo: la etiqueta ID3 y unos bytes (no se decodifica). */
const id3 = () => Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
/** Un cuadro MPEG-1 capa III sin etiqueta. */
const frame = () => Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0]);

describe("looksLikeMp3", () => {
  it("acepta ID3 y un cuadro de capa III, y rechaza otra cosa", () => {
    expect(looksLikeMp3(id3())).toBe(true);
    expect(looksLikeMp3(frame())).toBe(true);
    // RIFF (WAV) y OggS (OGG).
    expect(looksLikeMp3(new TextEncoder().encode("RIFF....WAVE"))).toBe(false);
    expect(looksLikeMp3(new TextEncoder().encode("OggS...."))).toBe(false);
    // Un cuadro AAC (ADTS, capa 00) no es MP3.
    expect(looksLikeMp3(Uint8Array.from([0xff, 0xf1, 0x50, 0x80]))).toBe(false);
    expect(looksLikeMp3(new Uint8Array(2))).toBe(false);
  });
});

describe("uploadMusicFolder", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "musica-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sube las pistas del catálogo como assets/musica/<id>.mp3 y rechaza lo demás", async () => {
    await writeFile(join(dir, "calm-piano.mp3"), id3());
    await writeFile(join(dir, "up-in-the-sky.MP3"), frame());
    await writeFile(join(dir, "otra-cancion.mp3"), id3());
    await writeFile(join(dir, "serenade-guitar.mp3"), new TextEncoder().encode("RIFF....WAVE"));
    await writeFile(join(dir, "sunny-side-up.mp3"), new Uint8Array());
    await writeFile(join(dir, ".DS_Store"), "x");
    await mkdir(join(dir, "champ-de-tournesol.mp3"));
    const storage = createInMemoryMediaStorage();

    const report = await uploadMusicFolder(storage, dir, decodesAll);

    expect(await storage.head("assets/musica/calm-piano.mp3")).toEqual({
      size: id3().length,
      contentType: "audio/mpeg",
    });
    expect(await storage.head("assets/musica/up-in-the-sky.mp3")).not.toBeNull();
    expect(await storage.list("assets/")).toHaveLength(2);
    const byFile = Object.fromEntries(
      report.outcomes.map((outcome) => [
        outcome.file,
        outcome.status === "uploaded" ? outcome.status : outcome.reason,
      ]),
    );
    expect(byFile).toEqual({
      "calm-piano.mp3": "uploaded",
      "champ-de-tournesol.mp3": "not_a_file",
      "otra-cancion.mp3": "unknown_track",
      "serenade-guitar.mp3": "not_mp3",
      "sunny-side-up.mp3": "empty",
      "up-in-the-sky.MP3": "uploaded",
    });
    expect(report.missing).toEqual(
      MUSIC_TRACK_IDS.filter((id) => id !== "calm-piano" && id !== "up-in-the-sky"),
    );
    const text = musicUploadText(report);
    expect(text).toContain("✓ calm-piano.mp3 → assets/musica/calm-piano.mp3");
    expect(text).toContain("✗ otra-cancion.mp3: el nombre no es una pista del catálogo");
    expect(text).toContain("No vinieron");
  });

  it("una carpeta vacía no sube nada y lo dice", async () => {
    const storage = createInMemoryMediaStorage();
    const report = await uploadMusicFolder(storage, dir, decodesAll);
    expect(report.outcomes).toEqual([]);
    expect(report.missing).toEqual([...MUSIC_TRACK_IDS]);
    expect(musicUploadText(report)).toContain("La carpeta no tiene archivos.");
  });

  it("una pista que ffmpeg no puede leer entera no se sube", async () => {
    await writeFile(join(dir, "calm-piano.mp3"), id3());
    await writeFile(join(dir, "up-in-the-sky.mp3"), id3());
    const storage = createInMemoryMediaStorage();
    const report = await uploadMusicFolder(storage, dir, async (path) =>
      path.endsWith("calm-piano.mp3"),
    );
    expect(report.outcomes.map((outcome) => [outcome.file, outcome.status])).toEqual([
      ["calm-piano.mp3", "uploaded"],
      ["up-in-the-sky.mp3", "rejected"],
    ]);
    expect(await storage.head("assets/musica/up-in-the-sky.mp3")).toBeNull();
    expect(musicUploadText(report)).toContain(
      "✗ up-in-the-sky.mp3: ffmpeg no lo puede leer entero",
    );
  });

  it("ffmpegDecodes con ffmpeg de verdad: un audio sano pasa; uno con la cabecera MP3 y basura, no", async () => {
    const good = join(dir, "bueno.m4a");
    execFileSync(FFMPEG, [
      ...["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"],
      ...["-t", "1", "-c:a", "aac", good],
    ]);
    const bad = join(dir, "malo.mp3");
    await writeFile(
      bad,
      Uint8Array.from([...id3(), ...Array.from({ length: 4000 }, (_, i) => i % 7)]),
    );
    const decodes = ffmpegDecodes(FFMPEG);
    expect(await decodes(good)).toBe(true);
    expect(await decodes(bad)).toBe(false);
  }, 30_000);
});
