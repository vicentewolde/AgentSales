import type { PostMediaItem } from "@agentsales/api/contracts";
import { describe, expect, it } from "vitest";
import { cutText, INSTAGRAM_CUT, LINKEDIN_CUT, postPreviewMedia } from "./preview.js";

const item = (id: string, kind: "image" | "video"): PostMediaItem => ({
  id,
  kind,
  mime: kind === "image" ? "image/jpeg" : "video/mp4",
  bytes: 10,
  sortOrder: 0,
  isCover: false,
  url: `https://r2.example/${id}`,
  thumbUrl: `https://r2.example/${id}-thumb.jpg`,
  width: null,
  height: null,
  durationS: null,
  variants: [],
});

describe("cutText", () => {
  it("un texto que cabe no se corta", () => {
    expect(cutText("Hola\nmundo", INSTAGRAM_CUT)).toBeNull();
    expect(cutText("a".repeat(INSTAGRAM_CUT.chars), INSTAGRAM_CUT)).toBeNull();
  });

  it("corta por caracteres visibles y termina en …, sin espacios antes", () => {
    const text = `${"a".repeat(124)} y sigue`;
    expect(cutText(text, INSTAGRAM_CUT)).toBe(`${"a".repeat(124)}…`);
    expect(cutText("b".repeat(LINKEDIN_CUT.chars + 1), LINKEDIN_CUT)).toBe(
      `${"b".repeat(LINKEDIN_CUT.chars)}…`,
    );
  });

  it("un emoji en el límite queda entero", () => {
    const text = `${"a".repeat(124)}🏢 y sigue`;
    expect(cutText(text, INSTAGRAM_CUT)).toBe(`${"a".repeat(124)}🏢…`);
  });

  it("corta por líneas: dos en Instagram, tres en LinkedIn", () => {
    expect(cutText("uno\ndos\ntres", INSTAGRAM_CUT)).toBe("uno\ndos…");
    expect(cutText("uno\ndos\ntres", LINKEDIN_CUT)).toBeNull();
    expect(cutText("uno\ndos\ntres\ncuatro", LINKEDIN_CUT)).toBe("uno\ndos\ntres…");
    // Una línea en blanco cuenta como línea, como en la red.
    expect(cutText("Casa\n\n#nunoa", INSTAGRAM_CUT)).toBe("Casa…");
  });
});

describe("postPreviewMedia", () => {
  const images = ["i1", "i2", "i3", "i4", "i5"].map((id) => item(id, "image"));
  const video = item("v1", "video");
  const media = [...images, video];
  const ids = (list: readonly { id: string }[]) => list.map((entry) => entry.id);

  it("un post de texto no lleva medios", () => {
    expect(postPreviewMedia("x", "text", media)).toEqual({ images: [], video: null });
  });

  it("X lleva hasta 4 imágenes; Discord y LinkedIn todas (hasta 10 en Discord)", () => {
    expect(ids(postPreviewMedia("x", "carousel", media).images)).toEqual(["i1", "i2", "i3", "i4"]);
    expect(ids(postPreviewMedia("discord", "carousel", media).images)).toHaveLength(5);
    expect(ids(postPreviewMedia("linkedin", "carousel", media).images)).toHaveLength(5);
  });

  it("Instagram: una sola imagen en un post de imagen, el carrusel entero si no", () => {
    expect(ids(postPreviewMedia("instagram", "image", media).images)).toEqual(["i1"]);
    expect(ids(postPreviewMedia("instagram", "carousel", media).images)).toHaveLength(5);
  });

  it("un video (y TikTok siempre) lleva el primer video, con su miniatura", () => {
    expect(postPreviewMedia("linkedin", "video", media)).toEqual({
      images: [],
      video: { id: "v1", src: null, poster: "https://r2.example/v1-thumb.jpg" },
    });
    expect(postPreviewMedia("tiktok", "image", media).video?.id).toBe("v1");
    expect(postPreviewMedia("tiktok", "video", images).video).toBeNull();
  });

  it("la foto es la miniatura del medio", () => {
    expect(postPreviewMedia("discord", "image", [images[0] ?? video]).images).toEqual([
      { id: "i1", src: "https://r2.example/i1-thumb.jpg" },
    ]);
  });
});
