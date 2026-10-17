import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createLogoNormalizer } from "../src/logo.js";
import { syntheticPhoto } from "./images.js";

// F7-T14 (spec F7 §4.6): el logo del corredor con sharp de verdad.

const logos = createLogoNormalizer();

describe("createLogoNormalizer", () => {
  it.each(["png", "jpeg"] as const)("un %s queda en PNG, sin agrandar", async (format) => {
    const input = await syntheticPhoto(300, 200, { format });
    const logo = await logos.normalize(input);
    expect((await sharp(logo.bytes).metadata()).format).toBe("png");
    expect([logo.width, logo.height]).toEqual([300, 200]);
  });

  it("un WebP con transparencia la conserva; uno grande queda en 1024 px por lado", async () => {
    const webp = await sharp({
      create: {
        width: 3000,
        height: 1500,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .webp()
      .toBuffer();
    const logo = await logos.normalize(new Uint8Array(webp));
    expect([logo.width, logo.height]).toEqual([1024, 512]);
    expect((await sharp(logo.bytes).metadata()).hasAlpha).toBe(true);
  });

  it.each([
    ["un SVG", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')],
    ["un archivo que no es imagen", new TextEncoder().encode("no soy una imagen")],
    ["un PNG cortado", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])],
  ])("%s es LOGO_INVALID", async (_name, input) => {
    await expect(logos.normalize(input)).rejects.toMatchObject({ code: "LOGO_INVALID" });
  });

  it("un GIF tampoco se acepta", async () => {
    const gif = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "#ff0000" },
    })
      .gif()
      .toBuffer();
    await expect(logos.normalize(new Uint8Array(gif))).rejects.toMatchObject({
      code: "LOGO_INVALID",
    });
  });
});
