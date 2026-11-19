import { describe, expect, it } from "vitest";
import { editorialProfileView } from "../editorial-profile.js";
import { buildPostCheckContext, checkPostContent } from "./check.js";
import { misspellings } from "./spelling.js";

// F9.7 B8: la ortografía de los textos editados a mano, con una lista acotada por idioma.

describe("misspellings", () => {
  it("encuentra las de la lista, con su corrección, sin repetir y sin mirar enlaces ni hashtags", () => {
    expect(
      misspellings("Tambien lo vi despues. tambien #tambien https://x.cl/tambien", "es"),
    ).toEqual([
      { word: "Tambien", suggestion: "también" },
      { word: "despues", suggestion: "después" },
    ]);
    expect(misspellings("I will recieve it tommorow", "en").map((item) => item.suggestion)).toEqual(
      ["receive", "tomorrow"],
    );
    // Una palabra ambigua («esta», «solo») no está en la lista: sin falsos positivos.
    expect(misspellings("Esta es solo una prueba", "es")).toEqual([]);
  });

  it("la revisión de un texto lo avisa (no bloquea aprobar)", () => {
    const ctx = buildPostCheckContext({
      post: {
        kind: "text",
        topic: "Tema",
        brief: null,
        briefOrigin: "ai",
        source: "ai",
        xLinkAllowed: false,
      },
      profile: editorialProfileView("marca", null),
      broker: { brandName: "Marca", fixedHashtags: [] },
      media: [],
    });
    const checks = checkPostContent(
      "linkedin",
      { body: "Aveces cuesta.", hashtags: [], language: "es" },
      ctx,
    );
    expect(checks.find((check) => check.code === "SPELLING")).toEqual({
      code: "SPELLING",
      severity: "warning",
      message: "Revisa la ortografía: «Aveces» → «a veces»",
    });
  });
});
