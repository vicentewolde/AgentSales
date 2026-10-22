import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MUSIC_TRACK_IDS } from "@agentsales/core";
import { createInMemoryMediaStorage } from "@agentsales/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { looksLikeMp3, musicUploadText, uploadMusicFolder } from "./music-upload.js";

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

    const report = await uploadMusicFolder(storage, dir);

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
    const report = await uploadMusicFolder(storage, dir);
    expect(report.outcomes).toEqual([]);
    expect(report.missing).toEqual([...MUSIC_TRACK_IDS]);
    expect(musicUploadText(report)).toContain("La carpeta no tiene archivos.");
  });
});
