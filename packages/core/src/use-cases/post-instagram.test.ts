import { describe, expect, it } from "vitest";
import { isAppError } from "../errors.js";
import type { Media } from "../media.js";
import { mediaForText } from "../post-media-language.js";
import { postSubject } from "../subject.js";
import { createPostPublicationScenario } from "../testing/index.js";
import { postPublicationPlan } from "./open-publications.js";

// F9-T13: qué publica Instagram de un post (imagen suelta, carrusel de 2 a 10 o reel), sin cambiar
// lo de las otras redes ni el carrusel de un aviso. Los contratos con la red están en
// `packages/publishers/src/instagram/post.test.ts`.

const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (error) {
    return isAppError(error) ? error.code : error;
  }
};

/** Los medios de un post del escenario (sin textos ni cuentas: solo interesan los medios). */
async function mediaOf(options: Parameters<typeof createPostPublicationScenario>[0]) {
  const t = await createPostPublicationScenario({ texts: [], accounts: [], ...options });
  const media = await t.media.listBySubject(postSubject(t.post.id));
  return { t, media };
}

const ids = (items: readonly Media[]) => items.map((item) => item.id);

describe("postPublicationPlan · Instagram (F9-T13)", () => {
  it("una imagen va como imagen suelta: el ig_4x5 de su primera foto, aunque haya más", async () => {
    const { t, media } = await mediaOf({ kind: "image", images: 3 });
    expect(postPublicationPlan("instagram", "image", media)).toEqual({
      format: "post",
      mediaIds: ids(t.images.slice(0, 1)),
    });
  });

  it("un carrusel lleva los ig_4x5 en su orden, de 2 a 10", async () => {
    const three = await mediaOf({ kind: "carousel", images: 3 });
    expect(postPublicationPlan("instagram", "carousel", three.media)).toEqual({
      format: "post",
      mediaIds: ids(three.t.images),
    });
    const twelve = await mediaOf({ kind: "carousel", images: 12 });
    expect(postPublicationPlan("instagram", "carousel", twelve.media)).toEqual({
      format: "post",
      mediaIds: ids(twelve.t.images.slice(0, 10)),
    });
  });

  it("un carrusel con menos de 2 fotos procesadas es CONTENT_NOT_READY", async () => {
    const { media } = await mediaOf({ kind: "carousel", images: 2 });
    // Una de las dos todavía no tiene su ig_4x5.
    const [firstVariant] = media.filter((item) => item.variant === "ig_4x5");
    const halfDone = media.filter((item) => item.id !== firstVariant?.id);
    expect(codeOf(() => postPublicationPlan("instagram", "carousel", halfDone))).toBe(
      "CONTENT_NOT_READY",
    );
  });

  it("un video va como reel con su ig_reel; sin procesar es CONTENT_NOT_READY", async () => {
    const { t, media } = await mediaOf({ kind: "video", images: 0, video: true });
    expect(postPublicationPlan("instagram", "video", media)).toEqual({
      format: "reel",
      mediaIds: [t.reel?.id],
    });
    const originals = media.filter((item) => item.role === "original");
    expect(codeOf(() => postPublicationPlan("instagram", "video", originals))).toBe(
      "CONTENT_NOT_READY",
    );
  });

  it("un video con fotos: el reel usa solo el video", async () => {
    const { t, media } = await mediaOf({ kind: "video", images: 2, video: true });
    expect(postPublicationPlan("instagram", "video", media)).toEqual({
      format: "reel",
      mediaIds: [t.reel?.id],
    });
  });

  it("un post de solo texto no se publica en Instagram", async () => {
    const { media } = await mediaOf({ kind: "text", images: 0 });
    expect(codeOf(() => postPublicationPlan("instagram", "text", media))).toBe("CONTENT_NOT_READY");
  });

  it("las otras redes no cambian: una imagen con varias fotos las lleva todas", async () => {
    const { t, media } = await mediaOf({ kind: "image", images: 3 });
    expect(postPublicationPlan("linkedin", "image", media)).toEqual({
      format: "post",
      mediaIds: ids(t.images),
    });
    // Un carrusel de una sola foto no tiene el mínimo de Instagram fuera de él.
    const one = await mediaOf({ kind: "carousel", images: 1 });
    expect(postPublicationPlan("linkedin", "carousel", one.media)).toEqual({
      format: "post",
      mediaIds: ids(one.t.images),
    });
  });
});

// ADR-0042: una imagen en inglés y otra en español. En X cada idioma sale con la suya; en
// Instagram, un post de imagen bilingüe sale como carrusel, primero la del idioma del texto.
describe("postPublicationPlan · el idioma de cada imagen (ADR-0042)", () => {
  async function bilingual() {
    const { t } = await mediaOf({ kind: "image", images: 2 });
    const subject = postSubject(t.post.id);
    const [spanish, english] = await t.media.listOriginals(subject);
    if (spanish === undefined || english === undefined) throw new Error("faltan las fotos");
    await t.media.setLanguage(subject, spanish.id, "es");
    await t.media.setLanguage(subject, english.id, "en");
    const media = await t.media.listBySubject(subject);
    const [es, en] = t.images.map((item) => item.id);
    return { media, es, en };
  }
  const plan = (
    media: readonly Media[],
    platform: "instagram" | "x",
    language: "es" | "en",
    kind: "image" | "carousel" = "image",
  ) =>
    postPublicationPlan(
      platform,
      kind,
      mediaForText(media, new Map(), platform, language),
      language,
    );

  it("X: cada idioma lleva solo su imagen", async () => {
    const { media, es, en } = await bilingual();
    expect(plan(media, "x", "es")).toEqual({ format: "post", mediaIds: [es] });
    expect(plan(media, "x", "en")).toEqual({ format: "post", mediaIds: [en] });
  });

  it("Instagram: un post de imagen bilingüe es carrusel, primero la del idioma del texto", async () => {
    const { media, es, en } = await bilingual();
    expect(plan(media, "instagram", "en")).toEqual({ format: "post", mediaIds: [en, es] });
    expect(plan(media, "instagram", "es")).toEqual({ format: "post", mediaIds: [es, en] });
    expect(plan(media, "instagram", "en", "carousel")).toEqual({
      format: "post",
      mediaIds: [en, es],
    });
  });

  it("sin el idioma del texto, Instagram sigue con la primera foto", async () => {
    const { media, es } = await bilingual();
    expect(postPublicationPlan("instagram", "image", media)).toEqual({
      format: "post",
      mediaIds: [es],
    });
  });
});
