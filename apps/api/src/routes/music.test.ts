import { MUSIC_TRACK_IDS } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { musicTrackListResponseSchema } from "../contracts/index.js";
import { adminApp, testDeps, testStorage } from "../testing/index.js";

describe("GET /music/tracks (F9.5-T19)", () => {
  it("lista el catálogo; las pistas subidas a R2 traen una URL firmada para escuchar", async () => {
    const storage = testStorage();
    await storage.put("assets/musica/calm-piano.mp3", Uint8Array.from([1, 2, 3]), "audio/mpeg");
    const app = adminApp(testDeps({ storage }));

    const response = await app.request("/music/tracks");
    expect(response.status).toBe(200);
    const { tracks } = musicTrackListResponseSchema.parse(await response.json());
    expect(tracks.map((track) => track.id)).toEqual([...MUSIC_TRACK_IDS]);
    expect(tracks[0]).toMatchObject({
      id: "calm-piano",
      style: "calm",
      license: "CC0-1.0",
      available: true,
      previewUrl: "https://r2.test/assets/musica/calm-piano.mp3?firma",
    });
    expect(tracks.slice(1).every((track) => !track.available && track.previewUrl === null)).toBe(
      true,
    );
  });

  it("sin sesión es 401", async () => {
    const response = await createApp(testDeps()).request("/music/tracks");
    expect(response.status).toBe(401);
  });
});
