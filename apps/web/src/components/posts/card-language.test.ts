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
    // Con una tarjeta propia, el cierre compartido no estorba.
    expect(cardLanguageNotice(media(["es", "en"], ["en"]), "en")).toBeNull();
  });

  it("el cierre que comparten dos idiomas no cuenta como tarjeta propia", () => {
    expect(cardLanguageNotice(media(["es", "en"], ["es"]), "en")).toBe(
      "Este texto está aprobado en inglés, pero las tarjetas del post están en español. En «Conseguir imagen», más abajo, pide las tarjetas en inglés.",
    );
  });

  it("con tarjetas solo de otro idioma, lo dice y qué hacer", () => {
    expect(cardLanguageNotice(media(null, ["en"], ["en"]), "es")).toBe(
      "Este texto está aprobado en español, pero las tarjetas del post están en inglés. En «Conseguir imagen», más abajo, pide las tarjetas en español.",
    );
  });

  it("con tarjetas de un pedido anterior (idioma desconocido), lo dice", () => {
    expect(cardLanguageNotice(media([]), "en")).toContain("no se sabe en qué idioma están");
  });
});
