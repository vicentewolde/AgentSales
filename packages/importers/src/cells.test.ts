import { describe, expect, it } from "vitest";
import { cellText, flattenCell } from "./cells.js";

describe("flattenCell", () => {
  it.each([
    ["fórmula", { formula: "A1*2", result: 5800 }, 5800],
    ["fórmula compartida", { sharedFormula: "A2", result: "Venta" }, "Venta"],
    ["fórmula sin resultado", { formula: "A1" }, null],
    ["hipervínculo", { text: "Ver video", hyperlink: "https://example.cl" }, "Ver video"],
    ["hipervínculo sin texto", { hyperlink: "https://example.cl" }, "https://example.cl"],
    ["texto enriquecido", { richText: [{ text: "Muy " }, { text: "luminoso" }] }, "Muy luminoso"],
    // El error queda como objeto: el validador lo rechaza en cualquier campo (FIELD_VALUE_INVALID).
    ["error de Excel", { error: "#DIV/0!" }, { error: "#DIV/0!" }],
    [
      "fórmula con texto enriquecido",
      { formula: "A1", result: { richText: [{ text: "x" }] } },
      "x",
    ],
    ["vacía", undefined, null],
    ["número", 42, 42],
  ])("%s", (_name, input, expected) => {
    expect(flattenCell(input)).toEqual(expected);
  });

  it("deja las fechas como Date y devuelve tal cual lo que no reconoce", () => {
    const date = new Date(Date.UTC(2026, 10, 15));
    expect(flattenCell(date)).toBe(date);
    const unknown = { algo: "raro" };
    expect(flattenCell(unknown)).toBe(unknown);
  });
});

describe("cellText", () => {
  it("devuelve el texto recortado de cualquier celda, o vacío", () => {
    expect(cellText("  precio ")).toBe("precio");
    expect(cellText({ richText: [{ text: " Tu valor " }] })).toBe("Tu valor");
    expect(cellText(null)).toBe("");
    expect(cellText(12)).toBe("12");
    expect(cellText({ error: "#REF!" })).toBe("#REF!");
    expect(cellText({ algo: "raro" })).toBe("");
  });
});
