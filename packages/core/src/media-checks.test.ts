import { describe, expect, it } from "vitest";
import {
  PHOTO_MIN_WIDTH,
  PHOTO_SIZE_WARNING_TEXT,
  photoSizeWarnings,
  REEL_WARNING_TEXT,
  reelWarnings,
} from "./media-checks.js";

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

describe("reelWarnings", () => {
  it.each([
    [2.9, ["VIDEO_TOO_SHORT"]],
    [3, []],
    [90, []],
    [90.5, ["VIDEO_TRIMMED"]],
    [null, []],
  ])("un video de %s s → %j", (durationS, codes) => {
    expect(reelWarnings(durationS).map((warning) => warning.code)).toEqual(codes);
  });

  it("los textos citan los topes", () => {
    expect(REEL_WARNING_TEXT.VIDEO_TOO_SHORT).toContain("3 s");
    expect(REEL_WARNING_TEXT.VIDEO_TRIMMED).toContain("90 s");
  });
});
