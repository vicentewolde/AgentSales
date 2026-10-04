import { INSTAGRAM_CAPTION_MAX_LENGTH, LISTING_TITLE_MAX_LENGTH } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { captionCounter, parseHashtags, titleCounter } from "./editor.js";

describe("editor de textos", () => {
  it("normaliza los hashtags como la API: sin tildes, vacíos ni repetidos", () => {
    expect(parseHashtags("Ñuñoa, #ñuñoa  #Depto\n#venta ,")).toEqual([
      "#nunoa",
      "#depto",
      "#venta",
    ]);
  });

  it("el contador de Instagram cuenta el caption con los hashtags", () => {
    const body = "a".repeat(INSTAGRAM_CAPTION_MAX_LENGTH - 8);
    expect(captionCounter(body, [])).toMatchObject({ over: false });
    // body + "\n\n" + "#nunoa" = 8 caracteres más.
    expect(captionCounter(body, ["#nunoa"])).toEqual({
      length: INSTAGRAM_CAPTION_MAX_LENGTH,
      max: INSTAGRAM_CAPTION_MAX_LENGTH,
      over: false,
    });
    expect(captionCounter(`${body}x`, ["#nunoa"]).over).toBe(true);
  });

  it("el título se pasa del tope de Portal", () => {
    expect(titleCounter("a".repeat(LISTING_TITLE_MAX_LENGTH)).over).toBe(false);
    expect(titleCounter("a".repeat(LISTING_TITLE_MAX_LENGTH + 1)).over).toBe(true);
  });
});
