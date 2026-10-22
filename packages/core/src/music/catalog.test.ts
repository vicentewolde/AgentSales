import { describe, expect, it } from "vitest";
import { canonicalJson } from "../canonical-json.js";
import { reelTextInput } from "../content/media-keys.js";
import { isAppError } from "../errors.js";
import { slideKeyInput } from "../ports/slide-templates.js";
import { createInMemoryListingRepository, createInMemoryMediaStorage } from "../testing/index.js";
import { setListingMusic } from "../use-cases/listing-music.js";
import {
  checkMusicTrackId,
  MUSIC_STYLE_TEXT,
  MUSIC_TRACK_IDS,
  MUSIC_TRACKS,
  musicTrackIdSchema,
  musicTrackPath,
  musicTrackText,
} from "./catalog.js";
import { resolveReelMusic } from "./reel-music.js";

describe("catálogo de música (F9.5-T19)", () => {
  it("cinco pistas CC0 (sin crédito), una por estilo, con su página de origen", () => {
    expect(MUSIC_TRACKS.map((track) => track.id)).toEqual([...MUSIC_TRACK_IDS]);
    expect(MUSIC_TRACKS.every((track) => track.license === "CC0-1.0")).toBe(true);
    expect(new Set(MUSIC_TRACKS.map((track) => track.style)).size).toBe(5);
    expect(
      MUSIC_TRACKS.every((track) => track.sourceUrl.startsWith("https://opengameart.org/")),
    ).toBe(true);
    expect(MUSIC_STYLE_TEXT.calm).toBe("Tranquila");
  });

  it("la clave de R2 y el texto de una pista", () => {
    expect(musicTrackPath("calm-piano")).toBe("assets/musica/calm-piano.mp3");
    expect(musicTrackText("serenade-guitar")).toBe("Serenade Guitar · Elegante");
    expect(musicTrackText(null)).toBe("Sin música");
    expect(musicTrackText("retirada")).toBe("retirada");
  });

  it("valida contra el catálogo: null es «sin música»; otro id, MUSIC_TRACK_INVALID", () => {
    expect(checkMusicTrackId(null)).toBeNull();
    expect(checkMusicTrackId("up-in-the-sky")).toBe("up-in-the-sky");
    let error: unknown;
    try {
      checkMusicTrackId("otra");
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error) && error.code).toBe("MUSIC_TRACK_INVALID");
    expect(musicTrackIdSchema.safeParse("otra").success).toBe(false);
  });
});

describe("la clave del reel sin música no cambia (F9.5-T19)", () => {
  it("sin música, el texto de la clave es el de antes; con música, suma el id", () => {
    const data = {
      operation: "Venta",
      propertyType: "Departamento",
      comuna: "Ñuñoa",
      price: "UF 5.800",
    } as unknown as Parameters<typeof reelTextInput>[0];
    const before = canonicalJson({ templates: "t1", processor: "1", data: slideKeyInput(data) });
    expect(reelTextInput(data, { templates: "t1", processor: "1" })).toBe(before);
    const withMusic = reelTextInput(data, { templates: "t1", processor: "1", music: "calm-piano" });
    expect(withMusic).not.toBe(before);
    expect(withMusic).toContain('"music":"calm-piano"');
  });
});

describe("resolveReelMusic", () => {
  it("sin pista, nada; con la pista en R2, la lee una sola vez; sin archivo o fuera del catálogo, aviso", async () => {
    const storage = createInMemoryMediaStorage();
    expect(await resolveReelMusic(storage, null)).toEqual({ music: null, warning: null });

    const missing = await resolveReelMusic(storage, "calm-piano");
    expect(missing.music).toBeNull();
    expect(missing.warning).toContain("todavía no está subida a la biblioteca");

    const gone = await resolveReelMusic(storage, "retirada");
    expect(gone.music).toBeNull();
    expect(gone.warning).toContain("ya no está en la biblioteca");

    await storage.put("assets/musica/calm-piano.mp3", Uint8Array.from([1, 2, 3]), "audio/mpeg");
    const found = await resolveReelMusic(storage, "calm-piano");
    expect(found.warning).toBeNull();
    expect(found.music?.track.id).toBe("calm-piano");
    const first = await found.music?.input();
    expect([...(first?.bytes ?? [])]).toEqual([1, 2, 3]);
    expect(await found.music?.input()).toBe(first);
  });
});

describe("setListingMusic", () => {
  it("elige y quita la música; un id fuera del catálogo o una propiedad que no existe fallan", async () => {
    const listings = createInMemoryListingRepository();
    const { id } = await listings.create({
      brokerId: "b1",
      category: "real_estate",
      source: "xlsx",
      externalRef: "M001",
      sourceHash: "h",
      operation: "sale",
      propertyType: "Casa",
      region: null,
      comuna: null,
      address: null,
      unitNumber: null,
      showExactAddress: false,
      priceAmount: 1,
      priceCurrency: "UF",
      highlights: null,
      internalNotes: null,
      attributes: {},
    });
    expect((await listings.get(id))?.musicTrackId).toBeNull();
    const chosen = await setListingMusic(
      { listings },
      { listingId: id, musicTrackId: "calm-piano" },
    );
    expect(chosen.musicTrackId).toBe("calm-piano");
    expect((await listings.get(id))?.musicTrackId).toBe("calm-piano");
    expect(
      (await setListingMusic({ listings }, { listingId: id, musicTrackId: null })).musicTrackId,
    ).toBeNull();
    await expect(
      setListingMusic({ listings }, { listingId: id, musicTrackId: "otra" }),
    ).rejects.toMatchObject({ code: "MUSIC_TRACK_INVALID" });
    await expect(
      setListingMusic({ listings }, { listingId: "no-existe", musicTrackId: null }),
    ).rejects.toMatchObject({ code: "LISTING_NOT_FOUND" });
  });
});
