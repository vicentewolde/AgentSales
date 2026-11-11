import type { PostMediaItem } from "@agentsales/api/contracts";
import { describe, expect, it } from "vitest";
import {
  cutText,
  draftDiffers,
  INSTAGRAM_CUT,
  LINKEDIN_CUT,
  mediaForText,
  postPreviewMedia,
} from "./preview.js";

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
  cardLanguages: null,
  language: null,
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

describe("draftDiffers", () => {
  const saved = { title: "Casa", body: "Texto", hashtags: ["#a"] };
  it("solo con un borrador distinto del guardado", () => {
    expect(draftDiffers(null, saved)).toBe(false);
    expect(draftDiffers({ ...saved }, saved)).toBe(false);
    expect(draftDiffers({ ...saved, body: "Otro" }, saved)).toBe(true);
    expect(draftDiffers({ ...saved, title: "Otra" }, saved)).toBe(true);
    expect(draftDiffers({ ...saved, hashtags: ["#a", "#b"] }, saved)).toBe(true);
    expect(draftDiffers({ ...saved }, null)).toBe(true);
  });
});

describe("mediaForText: cada texto ve las tarjetas de su idioma", () => {
  const card = (id: string, cardLanguages: PostMediaItem["cardLanguages"], sortOrder: number) => ({
    ...item(id, "image"),
    sortOrder,
    cardLanguages,
  });
  const media = [
    item("foto", "image"),
    card("es1", ["es"], 1),
    card("en1", ["en"], 2),
    card("cierre", ["es", "en"], 3),
  ];
  const ids = (list: readonly { id: string }[]) => list.map((entry) => entry.id);

  it("la foto del usuario va en los dos; el cierre compartido, también", () => {
    expect(ids(mediaForText(media, "x", "es"))).toEqual(["foto", "es1", "cierre"]);
    expect(ids(mediaForText(media, "x", "en"))).toEqual(["foto", "en1", "cierre"]);
    // Las tarjetas siguen su idioma también en Instagram.
    expect(ids(mediaForText(media, "instagram", "en"))).toEqual(["foto", "en1", "cierre"]);
  });

  it("sin tarjetas de su idioma, ve las únicas que haya", () => {
    const onlyEnglish = [item("foto", "image"), card("en1", ["en"], 1), card("cierre", ["en"], 2)];
    expect(ids(mediaForText(onlyEnglish, "x", "es"))).toEqual(["foto", "en1", "cierre"]);
  });

  it("sin tarjetas ni idiomas, no cambia nada", () => {
    const plain = [item("a", "image"), { ...item("b", "image"), sortOrder: 1 }];
    expect(ids(mediaForText(plain, "x", "es"))).toEqual(["a", "b"]);
  });
});

describe("el idioma de cada foto (ADR-0042)", () => {
  const photo = (id: string, sortOrder: number, language: PostMediaItem["language"]) =>
    ({
      ...item(id, "image"),
      sortOrder,
      language,
      variants: ["ig_4x5"],
    }) satisfies PostMediaItem;
  // La española se subió primero.
  const media = [photo("es", 0, "es"), photo("en", 1, "en")];
  const preview = (platform: "x" | "instagram", language: "es" | "en") =>
    postPreviewMedia(
      platform,
      "image",
      mediaForText(media, platform, language),
      language,
    ).images.map((image) => image.id);

  it("en X cada texto ve solo la foto de su idioma", () => {
    expect(preview("x", "es")).toEqual(["es"]);
    expect(preview("x", "en")).toEqual(["en"]);
  });

  it("en Instagram un post de imagen bilingüe se ve como carrusel, primero la del idioma del texto", () => {
    expect(preview("instagram", "en")).toEqual(["en", "es"]);
    expect(preview("instagram", "es")).toEqual(["es", "en"]);
  });

  it("sin marcas, Instagram muestra solo la primera de un post de imagen", () => {
    const plain = [photo("a", 0, null), photo("b", 1, null)];
    expect(
      postPreviewMedia("instagram", "image", mediaForText(plain, "instagram", "en"), "en").images,
    ).toHaveLength(1);
  });
});

describe("postPreviewMedia", () => {
  const photo = (id: string, sortOrder: number, variants: PostMediaItem["variants"] = ["ig_4x5"]) =>
    ({ ...item(id, "image"), sortOrder, variants }) satisfies PostMediaItem;
  const clip = (id: string, sortOrder: number, variants: PostMediaItem["variants"]) =>
    ({ ...item(id, "video"), sortOrder, variants }) satisfies PostMediaItem;
  const images = [1, 2, 3, 4, 5].map((n) => photo(`i${n}`, n));
  const video = clip("v1", 9, ["ig_reel", "x_video"]);
  const media = [...images, video];
  const ids = (list: readonly { id: string }[]) => list.map((entry) => entry.id);

  it("un post de texto no lleva medios", () => {
    expect(postPreviewMedia("x", "text", media)).toEqual({
      images: [],
      video: null,
      problem: null,
    });
  });

  it("X lleva hasta 4 imágenes; Discord y LinkedIn todas (hasta 10 en Discord)", () => {
    expect(ids(postPreviewMedia("x", "carousel", media).images)).toEqual(["i1", "i2", "i3", "i4"]);
    expect(ids(postPreviewMedia("discord", "carousel", media).images)).toHaveLength(5);
    expect(ids(postPreviewMedia("linkedin", "carousel", media).images)).toHaveLength(5);
  });

  it("en el orden del publisher: sortOrder y después el id, sin importar cómo llegan", () => {
    const shuffled = [photo("b", 2), photo("z", 1), photo("a", 2)];
    expect(ids(postPreviewMedia("linkedin", "carousel", shuffled).images)).toEqual(["z", "a", "b"]);
    const [late, early] = [clip("v-late", 5, ["ig_reel"]), clip("v-early", 1, ["ig_reel"])];
    expect(postPreviewMedia("linkedin", "video", [late, early]).video?.id).toBe("v-early");
  });

  it("Instagram: una sola imagen en un post de imagen, el carrusel entero si no", () => {
    expect(ids(postPreviewMedia("instagram", "image", media).images)).toEqual(["i1"]);
    expect(ids(postPreviewMedia("instagram", "carousel", media).images)).toHaveLength(5);
  });

  it("una foto sin su ig_4x5 queda «procesando»", () => {
    const { images: shown } = postPreviewMedia("x", "carousel", [
      photo("listo", 1),
      photo("pendiente", 2, ["thumb"]),
    ]);
    expect(shown).toEqual([
      { id: "listo", src: "https://r2.example/listo-thumb.jpg", processing: false },
      { id: "pendiente", src: "https://r2.example/pendiente-thumb.jpg", processing: true },
    ]);
  });

  it("el video necesita la versión de cada red: ig_reel, x_video en X y cualquiera en Discord", () => {
    expect(postPreviewMedia("linkedin", "video", media)).toEqual({
      images: [],
      video: {
        id: "v1",
        src: null,
        poster: "https://r2.example/v1-thumb.jpg",
        processing: false,
      },
      problem: null,
    });
    const onlyReel = [clip("v", 1, ["thumb", "ig_reel"])];
    expect(postPreviewMedia("x", "video", onlyReel).video?.processing).toBe(true);
    expect(postPreviewMedia("discord", "video", onlyReel).video?.processing).toBe(false);
    expect(postPreviewMedia("tiktok", "video", onlyReel).video?.processing).toBe(false);
    const onlyX = [clip("v", 1, ["x_video"])];
    expect(postPreviewMedia("discord", "video", onlyX).video?.processing).toBe(false);
    expect(postPreviewMedia("instagram", "video", onlyX).video?.processing).toBe(true);
    expect(postPreviewMedia("tiktok", "video", images).video).toBeNull();
  });

  it("avisa lo que el publisher rechazaría: TikTok sin video y un carrusel de menos de 2", () => {
    expect(postPreviewMedia("tiktok", "image", media)).toEqual({
      images: [],
      video: null,
      problem: "TikTok publica solo video: cambia el tipo del post y súbelo.",
    });
    expect(postPreviewMedia("instagram", "carousel", [photo("solo", 1)]).problem).toBe(
      "Un carrusel lleva de 2 a 10 imágenes y este post tiene 1.",
    );
    expect(postPreviewMedia("instagram", "carousel", media).problem).toBeNull();
    expect(postPreviewMedia("instagram", "text", media).problem).toBe(
      "Instagram necesita una imagen o un video.",
    );
  });

  it("la foto es la miniatura del medio", () => {
    expect(postPreviewMedia("discord", "image", [photo("i1", 1)]).images).toEqual([
      { id: "i1", src: "https://r2.example/i1-thumb.jpg", processing: false },
    ]);
  });
});
