import { describe, expect, it } from "vitest";
import { CAPTION_PREVIEW_LENGTH, captionPreview } from "./caption.js";

describe("captionPreview", () => {
  it("un caption corto no se corta", () => {
    expect(captionPreview({ body: "Hola", hashtags: [] })).toEqual({ full: "Hola", preview: null });
  });

  it("corta por caracteres visibles: un emoji en el límite queda entero", () => {
    const body = `${"a".repeat(CAPTION_PREVIEW_LENGTH - 1)}🏢 y sigue`;
    const { preview } = captionPreview({ body, hashtags: [] });
    expect(preview).toBe(`${"a".repeat(CAPTION_PREVIEW_LENGTH - 1)}🏢…`);
  });
});
