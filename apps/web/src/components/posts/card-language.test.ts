import { describe, expect, it } from "vitest";
import { cardLanguageNotice } from "./card-language.js";

// F9.5 (tarjetas por idioma): el aviso de un texto sin tarjetas de su idioma.

const media = (...cardLanguages: (("es" | "en")[] | null)[]) =>
  cardLanguages.map((languages) => ({ cardLanguages: languages }));

describe("cardLanguageNotice", () => {
  it("sin tarjetas en el post, o con tarjetas de su idioma, no avisa", () => {
    expect(cardLanguageNotice([], "es")).toBeNull();
    expect(cardLanguageNotice(media(null, null), "en")).toBeNull();
    expect(cardLanguageNotice(media(["es"], ["en"]), "en")).toBeNull();
    // El cierre compartido cuenta para los dos idiomas.
    expect(cardLanguageNotice(media(["es", "en"]), "en")).toBeNull();
  });

  it("con tarjetas solo de otro idioma, lo dice y qué hacer", () => {
    expect(cardLanguageNotice(media(null, ["en"], ["en"]), "es")).toBe(
      "Este texto está en español, pero las tarjetas del post están en inglés: en «Conseguir imagen» haz las tarjetas en español.",
    );
  });

  it("con tarjetas de un pedido anterior (idioma desconocido), lo dice", () => {
    expect(cardLanguageNotice(media([]), "en")).toContain("no se sabe en qué idioma están");
  });
});
