import { describe, expect, it } from "vitest";
import type { Language } from "./enums.js";
import {
  isBilingualImageSet,
  type LanguageMediaItem,
  mediaForText,
  otherLanguageOriginals,
} from "./post-media-language.js";

// ADR-0042: qué medios lleva el texto de una red en un idioma.

const original = (id: string, sortOrder: number, language: Language | null): LanguageMediaItem => ({
  id,
  sortOrder,
  role: "original",
  parentMediaId: null,
  language,
});
const variant = (id: string, parent: string): LanguageMediaItem => ({
  id,
  sortOrder: 0,
  role: "processed",
  parentMediaId: parent,
});
const ids = (items: readonly LanguageMediaItem[]) => items.map((item) => item.id);
const NO_CARDS = new Map<string, readonly Language[]>();

describe("mediaForText", () => {
  // Subidas al revés: la española primero (orden 0) y la inglesa después (orden 1).
  const media = [
    original("es", 0, "es"),
    original("en", 1, "en"),
    variant("es-4x5", "es"),
    variant("en-4x5", "en"),
  ];

  it("en X cada idioma lleva solo su imagen (y sus variantes)", () => {
    expect(ids(mediaForText(media, NO_CARDS, "x", "en"))).toEqual(["en", "en-4x5"]);
    expect(ids(mediaForText(media, NO_CARDS, "x", "es"))).toEqual(["es", "es-4x5"]);
  });

  it("LinkedIn, Discord y TikTok separan igual que X", () => {
    for (const platform of ["linkedin", "discord", "tiktok"] as const) {
      expect(ids(mediaForText(media, NO_CARDS, platform, "en"))).toEqual(["en", "en-4x5"]);
    }
  });

  it("en Instagram lleva todas, primero la del idioma del texto", () => {
    expect(ids(mediaForText(media, NO_CARDS, "instagram", "en"))).toEqual([
      "en",
      "es",
      "es-4x5",
      "en-4x5",
    ]);
    expect(ids(mediaForText(media, NO_CARDS, "instagram", "es"))).toEqual([
      "es",
      "en",
      "es-4x5",
      "en-4x5",
    ]);
  });

  it("lo que sirve para todos los idiomas va en todos, en su orden", () => {
    const mixed = [original("todos", 0, null), original("en", 1, "en"), original("es", 2, "es")];
    expect(ids(mediaForText(mixed, NO_CARDS, "x", "es"))).toEqual(["todos", "es"]);
    expect(ids(mediaForText(mixed, NO_CARDS, "instagram", "es"))).toEqual(["todos", "es", "en"]);
  });

  it("sin marcas de idioma, todo como antes (en su orden)", () => {
    const plain = [original("b", 1, null), original("a", 0, null), { id: "c", sortOrder: 2 }];
    expect(ids(mediaForText(plain, NO_CARDS, "x", "en"))).toEqual(["a", "b", "c"]);
  });

  it("las tarjetas siguen su regla por idioma, también en Instagram", () => {
    const cards = new Map<string, readonly Language[]>([
      ["card-es", ["es"]],
      ["card-en", ["en"]],
    ]);
    const withCards = [original("card-es", 0, null), original("card-en", 1, null)];
    expect(ids(mediaForText(withCards, cards, "instagram", "en"))).toEqual(["card-en"]);
    expect(ids(mediaForText(withCards, cards, "x", "es"))).toEqual(["card-es"]);
  });
});

describe("otherLanguageOriginals e isBilingualImageSet", () => {
  it("fuera de Instagram dice qué quedó fuera solo por su idioma", () => {
    const media = [original("en", 0, "en"), original("todos", 1, null)];
    expect(ids(otherLanguageOriginals(media, "x", "es"))).toEqual(["en"]);
    expect(otherLanguageOriginals(media, "instagram", "es")).toEqual([]);
  });

  it("un juego de imágenes es bilingüe con 2 o más y alguna de otro idioma", () => {
    expect(isBilingualImageSet([{ language: "en" }, { language: "es" }], "en")).toBe(true);
    expect(isBilingualImageSet([{ language: null }, { language: "es" }], "en")).toBe(true);
    expect(isBilingualImageSet([{ language: "en" }, { language: null }], "en")).toBe(false);
    expect(isBilingualImageSet([{ language: "es" }], "en")).toBe(false);
    expect(isBilingualImageSet([{}, {}], "en")).toBe(false);
  });
});
