import { describe, expect, it } from "vitest";
import { contrast, readableOn } from "./html.js";

describe("readableOn", () => {
  it.each([
    ["#1F4E79", "#FFFFFF"],
    ["#000000", "#FFFFFF"],
    ["#F5F5F5", "#111827"],
    ["#F2A900", "#111827"],
    // Un verde medio: el texto oscuro se lee mucho mejor que el blanco.
    ["#4CAF50", "#111827"],
  ])("sobre %s, texto %s", (background, text) => {
    expect(readableOn(background)).toBe(text);
  });

  it("siempre elige el de mayor contraste", () => {
    for (const background of ["#4CAF50", "#808080", "#E91E63", "#3F51B5", "#FFEB3B"]) {
      const chosen = readableOn(background);
      const other = chosen === "#FFFFFF" ? "#111827" : "#FFFFFF";
      expect(contrast(chosen, background)).toBeGreaterThanOrEqual(contrast(other, background));
    }
  });
});
