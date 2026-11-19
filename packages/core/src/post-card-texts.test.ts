import { describe, expect, it } from "vitest";
import { buildImagePdf, jpegSize } from "./image-pdf.js";
import { cardDeckFromTexts, checkCardText, normalizeCardTexts } from "./post-card-texts.js";
import { pickSlides } from "./social/draft.js";

// F9.7 B5 y B7: los textos de las láminas (revisión, edición y mazo) y el PDF de LinkedIn.

const ctx = { sources: "AgentPey\nAgentPey pasó 1.200 pagos en testnet", avoid: ["gratis"] };

describe("checkCardText", () => {
  it("marca la cifra ajena, lo que se evita y el largo en palabras", () => {
    expect(checkCardText({ headline: "1.200 pagos en testnet", subtitle: "" }, ctx)).toEqual([]);
    const codes = checkCardText(
      {
        headline: "Ahora 5.000 pagos gratis para todos los que se suman hoy mismo",
        subtitle: "",
      },
      ctx,
    ).map((check) => check.code);
    expect(codes).toEqual(["FACT_NOT_IN_PROFILE", "TOO_LONG", "AVOID_TERM"]);
  });
});

describe("normalizeCardTexts y el mazo", () => {
  it("la primera es la portada, sin vacías ni saltos; con un error claro", () => {
    expect(
      normalizeCardTexts([{ headline: " Portada\n", subtitle: "Sub" }, { headline: "Punto" }]),
    ).toEqual([
      { role: "cover", headline: "Portada", subtitle: "Sub" },
      { role: "point", headline: "Punto", subtitle: "" },
    ]);
    expect(() => normalizeCardTexts([{ headline: "  " }])).toThrow(
      expect.objectContaining({ code: "CARD_TEXTS_INVALID" }),
    );
  });

  it("un carrusel: portada con la grilla, un punto por lámina (con el tope) y el cierre", () => {
    const texts = [
      { role: "cover" as const, headline: "Portada", subtitle: "Sub", position: 1 },
      { role: "point" as const, headline: "Uno", subtitle: "", position: 2 },
      { role: "point" as const, headline: "Dos", subtitle: "Dos sub", position: 3 },
      { role: "point" as const, headline: "Tres", subtitle: "", position: 4 },
    ];
    const deck = cardDeckFromTexts({
      texts,
      kind: "carousel",
      brandName: "AgentPey",
      detail: "@agentpeyai",
      maxPoints: 2,
    });
    expect(deck.map((card) => [card.role, card.text, card.position, card.total])).toEqual([
      ["cover", "Portada", 1, 4],
      ["point", "Uno", 2, 4],
      ["point", "Dos", 3, 4],
      ["closing", "AgentPey", 4, 4],
    ]);
    expect(deck[0]?.items?.map((item) => item.text)).toEqual(["Uno", "Dos"]);
    expect(
      cardDeckFromTexts({ texts, kind: "image", brandName: "A", detail: null, maxPoints: 0 }),
    ).toHaveLength(1);
  });

  it("de la respuesta de la IA quedan una portada por idioma pedido y los puntos que caben", () => {
    const slide = (language: "es" | "en", role: "cover" | "point", headline: string) => ({
      language,
      role,
      headline,
      subtitle: "",
    });
    expect(
      pickSlides(
        [
          slide("es", "point", "P1"),
          slide("es", "cover", "C"),
          slide("es", "cover", "C2"),
          slide("es", "point", "P2"),
          slide("en", "cover", "EN"),
        ],
        { languages: ["es"], maxPoints: 1 },
      ).map((item) => item.headline),
    ).toEqual(["C", "P1"]);
    expect(pickSlides(undefined, { languages: ["es"], maxPoints: 2 })).toEqual([]);
  });
});

describe("el PDF de LinkedIn", () => {
  // Un JPEG mínimo: SOI, un SOF0 de 4×3 con 3 componentes y EOI (solo se leen sus medidas).
  const jpeg = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x03, 0x00,
    0x04, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ]);

  it("lee las medidas del JPEG y arma una página por imagen", () => {
    expect(jpegSize(jpeg)).toEqual({ width: 4, height: 3, components: 3 });
    expect(jpegSize(Uint8Array.from([0x89, 0x50]))).toBeNull();
    const pdf = buildImagePdf([jpeg, jpeg], "Carrusel de prueba");
    const text = Array.from(pdf, (byte) => String.fromCharCode(byte)).join("");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Count 2");
    expect(text.match(/\/Subtype \/Image/g)).toHaveLength(2);
    expect(text).toContain("/MediaBox [0 0 4 3]");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    // La tabla xref apunta a cada objeto.
    const start = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(start, start + 4)).toBe("xref");
    const offsets = [...text.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    );
    for (const [index, offset] of offsets.entries()) {
      expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`);
    }
  });
});

describe("lámina sin subtítulo (F9.7 B5)", () => {
  it("un subtítulo vacío o ausente es válido, no da aviso y el mazo lo deja sin subtítulo", () => {
    expect(
      checkCardText({ headline: "Solo el titular", subtitle: "" }, { sources: "", avoid: [] }),
    ).toEqual([]);
    const texts = normalizeCardTexts([
      { headline: "Solo el titular" },
      { headline: "Punto", subtitle: null },
    ]);
    expect(texts.map((text) => text.subtitle)).toEqual(["", ""]);
    const deck = cardDeckFromTexts({
      texts: texts.map((text, index) => ({ ...text, position: index + 1 })),
      kind: "image",
      brandName: "AgentPey",
      detail: "@agentpeyai",
      maxPoints: 4,
    });
    expect(deck[0]?.subtitle).toBeNull();
  });
});
