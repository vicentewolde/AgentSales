import { INSTAGRAM_CAPTION_MAX_LENGTH, LISTING_TITLE_MAX_LENGTH } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { parseHashtags, textCounter } from "./editor.js";

describe("editor de textos", () => {
  it("separa y normaliza los hashtags como la API", () => {
    expect(parseHashtags("Ñuñoa, #ñuñoa  #Depto\n#venta ,")).toEqual([
      "#nunoa",
      "#depto",
      "#venta",
    ]);
  });

  it("el contador de Instagram cuenta el caption con los hashtags y sin espacios al final", () => {
    const body = "a".repeat(INSTAGRAM_CAPTION_MAX_LENGTH - 8);
    const count = (text: string, hashtags: string[]) =>
      textCounter("instagram", { title: null, body: text, hashtags });
    // body + "\n\n" + "#nunoa" = 8 caracteres más.
    expect(count(body, ["#nunoa"])).toEqual({
      length: INSTAGRAM_CAPTION_MAX_LENGTH,
      max: INSTAGRAM_CAPTION_MAX_LENGTH,
      over: false,
    });
    expect(count(`${body}   \n`, ["#nunoa"]).over).toBe(false);
    expect(count(`${body}x`, ["#nunoa"]).over).toBe(true);
  });

  it("en Portal cuenta el título", () => {
    const count = (title: string) =>
      textCounter("portal_inmobiliario", { title, body: "x", hashtags: [] });
    expect(count("a".repeat(LISTING_TITLE_MAX_LENGTH)).over).toBe(false);
    expect(count("a".repeat(LISTING_TITLE_MAX_LENGTH + 1)).over).toBe(true);
  });
});
