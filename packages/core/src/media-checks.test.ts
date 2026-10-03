import { describe, expect, it } from "vitest";
import { PHOTO_MIN_WIDTH, PHOTO_SIZE_WARNING_TEXT, photoSizeWarnings } from "./media-checks.js";

describe("photoSizeWarnings", () => {
  it.each([
    [800, ["IMAGE_SMALL_FOR_INSTAGRAM", "IMAGE_SMALL_FOR_PORTAL"]],
    [1079, ["IMAGE_SMALL_FOR_INSTAGRAM", "IMAGE_SMALL_FOR_PORTAL"]],
    [1080, ["IMAGE_SMALL_FOR_PORTAL"]],
    [1199, ["IMAGE_SMALL_FOR_PORTAL"]],
    [1200, []],
    [null, []],
  ])("una foto de %s px de ancho → %j", (width, codes) => {
    expect(photoSizeWarnings(width).map((warning) => warning.code)).toEqual(codes);
  });

  it("los textos citan el umbral con formato chileno", () => {
    expect(PHOTO_MIN_WIDTH).toEqual({ instagram: 1080, portal: 1200 });
    expect(PHOTO_SIZE_WARNING_TEXT.IMAGE_SMALL_FOR_INSTAGRAM).toContain("1080 px");
    expect(PHOTO_SIZE_WARNING_TEXT.IMAGE_SMALL_FOR_PORTAL).toContain("1200 px");
  });
});
