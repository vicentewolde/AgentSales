import type { PublishInput, PublishMediaItem } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { validateInstagramInput } from "./validate.js";

const photo = (index: number, overrides: Partial<PublishMediaItem> = {}): PublishMediaItem => ({
  mediaId: `m-${index}`,
  kind: "image",
  mime: "image/jpeg",
  storagePath: `brokers/b/listings/l/processed/ig_4x5/${index}.jpg`,
  url: `https://r2.test/${index}.jpg`,
  bytes: 300_000,
  width: 1080,
  height: 1350,
  durationS: null,
  ...overrides,
});

const reel = (overrides: Partial<PublishMediaItem> = {}): PublishMediaItem => ({
  ...photo(1),
  kind: "video",
  mime: "video/mp4",
  storagePath: "brokers/b/listings/l/processed/ig_reel/a-b.mp4",
  url: "https://r2.test/reel.mp4",
  width: 1080,
  height: 1920,
  durationS: 42,
  ...overrides,
});

const post = (media: PublishMediaItem[], caption = "Depto en Ñuñoa #nunoa"): PublishInput => ({
  publicationId: "pub-1",
  platform: "instagram",
  format: "post",
  title: null,
  caption,
  media,
});

const codes = (input: PublishInput) => {
  const result = validateInstagramInput(input);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
};

describe("validateInstagramInput", () => {
  it("acepta una imagen suelta, un carrusel de 10 y un reel de 3 a 90 s", () => {
    expect(validateInstagramInput(post([photo(1)]))).toEqual({ ok: true });
    expect(validateInstagramInput(post(Array.from({ length: 10 }, (_, i) => photo(i))))).toEqual({
      ok: true,
    });
    for (const durationS of [3, 42, 90, 90.04]) {
      expect(codes({ ...post([reel({ durationS })]), format: "reel" })).toEqual([]);
    }
  });

  it("un post sin imágenes o con más de 10 no pasa", () => {
    expect(codes(post([]))).toEqual(["NO_MEDIA"]);
    expect(codes(post(Array.from({ length: 11 }, (_, i) => photo(i))))).toEqual(["TOO_MANY_ITEMS"]);
  });

  it("solo JPEG de menos de 8 MB y con proporción de 4:5 a 1,91:1", () => {
    expect(codes(post([photo(1, { mime: "image/png" })]))).toEqual(["NOT_JPEG"]);
    expect(codes(post([photo(1, { kind: "video", mime: "video/mp4" })]))).toEqual(["NOT_JPEG"]);
    expect(codes(post([photo(1, { bytes: 8 * 1024 * 1024 })]))).toEqual(["IMAGE_TOO_LARGE"]);
    expect(codes(post([photo(1, { width: 1080, height: 1920 })]))).toEqual(["BAD_ASPECT_RATIO"]);
    expect(codes(post([photo(1, { width: 2000, height: 1000 })]))).toEqual(["BAD_ASPECT_RATIO"]);
    // 1,91:1 (el borde) y una imagen sin medidas pasan.
    expect(codes(post([photo(1, { width: 1910, height: 1000 })]))).toEqual([]);
    expect(codes(post([photo(1, { width: null, height: null })]))).toEqual([]);
  });

  it("el reel es exactamente un MP4 de duración conocida entre 3 y 90 s", () => {
    const asReel = (media: PublishMediaItem[]): PublishInput => ({
      ...post(media),
      format: "reel",
    });
    expect(codes(asReel([]))).toEqual(["REEL_NEEDS_ONE_VIDEO"]);
    expect(codes(asReel([reel(), reel()]))).toEqual(["REEL_NEEDS_ONE_VIDEO"]);
    expect(codes(asReel([reel({ mime: "video/quicktime" })]))).toEqual(["NOT_MP4"]);
    expect(codes(asReel([photo(1)]))).toEqual(["NOT_MP4", "REEL_DURATION_UNKNOWN"]);
    expect(codes(asReel([reel({ durationS: 2.9 })]))).toEqual(["REEL_TOO_SHORT"]);
    expect(codes(asReel([reel({ durationS: 91 })]))).toEqual(["REEL_TOO_LONG"]);
  });

  it("el caption respeta su largo, 30 hashtags y 20 menciones", () => {
    expect(codes(post([photo(1)], "a".repeat(2200)))).toEqual([]);
    expect(codes(post([photo(1)], "a".repeat(2201)))).toEqual(["CAPTION_TOO_LONG"]);
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `#tag${i}`).join(" ");
    expect(codes(post([photo(1)], tags(30)))).toEqual([]);
    expect(codes(post([photo(1)], tags(31)))).toEqual(["TOO_MANY_HASHTAGS"]);
    const mentions = (n: number) => Array.from({ length: n }, (_, i) => `@cuenta${i}`).join(" ");
    expect(codes(post([photo(1)], mentions(20)))).toEqual([]);
    expect(codes(post([photo(1)], mentions(21)))).toEqual(["TOO_MANY_MENTIONS"]);
    // Un correo no es una mención.
    expect(codes(post([photo(1)], `${mentions(20)} contacto@corredora.cl`))).toEqual([]);
  });

  it("los mensajes van en español, sin datos del aviso", () => {
    const result = validateInstagramInput(
      post([photo(1, { mime: "image/png" })], "a".repeat(2201)),
    );
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: "NOT_JPEG", message: "El carrusel solo admite imágenes JPEG" },
        { code: "CAPTION_TOO_LONG", message: "El caption supera los 2.200 caracteres" },
      ],
    });
  });
});
