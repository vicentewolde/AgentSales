import { describe, expect, it } from "vitest";
import {
  normalizePostLanguages,
  postLanguages,
  postTextVisible,
  postWritesIn,
} from "./post-languages.js";
import { postShowsPublication } from "./post-networks.js";

// Los idiomas de un post (2026-11-15): los suyos o los de la marca, en una sola regla.

describe("postLanguages", () => {
  it("sin idiomas propios, los de la marca (el principal primero)", () => {
    expect(postLanguages({ languages: null }, ["en", "es"])).toEqual(["en", "es"]);
    expect(postLanguages({ languages: null }, [])).toEqual(["es"]);
  });

  it("con idiomas propios, esos, en el orden de la marca y después el de LANGUAGES", () => {
    expect(postLanguages({ languages: ["es"] }, ["es", "en"])).toEqual(["es"]);
    expect(postLanguages({ languages: ["es", "en"] }, ["en"])).toEqual(["en", "es"]);
    expect(postLanguages({ languages: ["en"] }, ["es"])).toEqual(["en"]);
    expect(postWritesIn({ languages: null }, ["es"], "en")).toBe(false);
    expect(postWritesIn({ languages: ["en"] }, ["es"], "en")).toBe(true);
  });
});

describe("postTextVisible", () => {
  it("se oculta el texto sin aprobar de un idioma quitado; el aprobado se muestra", () => {
    expect(postTextVisible({ language: "en", status: "draft" }, ["es"])).toBe(false);
    expect(postTextVisible({ language: "en", status: "edited" }, ["es"])).toBe(false);
    expect(postTextVisible({ language: "en", status: "approved" }, ["es"])).toBe(true);
    expect(postTextVisible({ language: "es", status: "draft" }, ["es"])).toBe(true);
  });
});

describe("normalizePostLanguages", () => {
  it("ordena, quita repetidos y pasa a minúsculas; null son los de la marca", () => {
    expect(normalizePostLanguages(["EN", " es ", "en"])).toEqual(["es", "en"]);
    expect(normalizePostLanguages(null)).toBeNull();
  });

  it("vacío u otro idioma es POST_INVALID", () => {
    expect(() => normalizePostLanguages([])).toThrowError(
      expect.objectContaining({ code: "POST_INVALID" }),
    );
    expect(() => normalizePostLanguages(["fr"])).toThrowError(
      expect.objectContaining({ code: "POST_INVALID" }),
    );
  });
});

describe("postShowsPublication", () => {
  it("una red que el post no tiene solo muestra lo que ya salió", () => {
    const post = { platforms: ["x" as const] };
    expect(postShowsPublication(post, { platform: "x", status: "failed" })).toBe(true);
    expect(postShowsPublication(post, { platform: "linkedin", status: "failed" })).toBe(false);
    expect(postShowsPublication(post, { platform: "linkedin", status: "published" })).toBe(true);
    expect(
      postShowsPublication({ platforms: null }, { platform: "linkedin", status: "failed" }),
    ).toBe(true);
    expect(postShowsPublication({}, { platform: "linkedin", status: "failed" })).toBe(true);
  });
});
