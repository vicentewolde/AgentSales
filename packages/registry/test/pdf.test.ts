import { describe, expect, it } from "vitest";
import { pdfPages } from "../src/adapters/pdf.js";

describe("pdfPages", () => {
  it("un archivo que no existe falla en vez de devolver páginas vacías", async () => {
    await expect(pdfPages("/no/existe.pdf")).rejects.toBeDefined();
  });
});
