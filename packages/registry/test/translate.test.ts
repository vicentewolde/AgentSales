import { describe, expect, it } from "vitest";
import { looksSpanish, MuseTranslator, sameNumbers } from "../src/gateway/translate.js";

describe("language detection", () => {
  it("recognises Spanish questions, with or without accents or question marks", () => {
    for (const q of [
      "¿Se aceptan mascotas?",
      "tiene tina",
      "cuanto son los gastos comunes",
      "Hay estacionamiento incluido?",
      "¿Dónde está?",
    ])
      expect(looksSpanish(q)).toBe(true);
  });
  it("leaves English alone", () => {
    for (const q of [
      "Does it have a bathtub?",
      "Are pets allowed and how much are the common expenses?",
      "What is the floor?",
    ])
      expect(looksSpanish(q)).toBe(false);
  });
});

describe("number guard", () => {
  it("accepts equal numbers whatever the formatting", () => {
    expect(
      sameNumbers(
        "Common expenses are 42000 pesos per month.",
        "Los gastos comunes son 42.000 pesos al mes.",
      ),
    ).toBe(true);
    expect(sameNumbers("It has 2 bedrooms.", "Tiene 2 dormitorios.")).toBe(true);
  });
  it("rejects a changed, added or dropped number", () => {
    expect(sameNumbers("Common expenses are 42000 pesos.", "Los gastos son 24000 pesos.")).toBe(
      false,
    );
    expect(sameNumbers("Pets are allowed.", "Se aceptan 2 mascotas.")).toBe(false);
    expect(sameNumbers("It is on floor 12.", "Está en el piso.")).toBe(false);
  });
});

describe("translator", () => {
  const client = (out: string | Error) =>
    ({
      respond: async () => {
        if (out instanceof Error) throw out;
        return { text: out, usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0 };
      },
    }) as never;
  it("returns a faithful translation", async () => {
    expect(
      await new MuseTranslator(client("Los gastos comunes son 42000 pesos al mes.")).toSpanish(
        "Common expenses are 42000 pesos per month.",
      ),
    ).toBe("Los gastos comunes son 42000 pesos al mes.");
  });
  it("drops a translation that changes a number, is empty, or when the model fails", async () => {
    for (const out of ["Los gastos comunes son 24000 pesos.", "", new Error("over budget")])
      expect(
        await new MuseTranslator(client(out)).toSpanish(
          "Common expenses are 42000 pesos per month.",
        ),
      ).toBeNull();
  });
});
