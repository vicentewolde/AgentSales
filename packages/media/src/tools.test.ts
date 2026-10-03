import { describe, expect, it } from "vitest";
import { isSupportedFfmpeg, parseFfmpegVersion } from "./tools.js";

describe("parseFfmpegVersion e isSupportedFfmpeg", () => {
  it.each([
    ["ffmpeg version 9.0.1 Copyright (c) 2000-2026", { major: 9, minor: 0 }, true],
    ["ffmpeg version n9.0.1-11-ge47273f4d9 Copyright", { major: 9, minor: 0 }, true],
    ["ffprobe version 8.1 Copyright", { major: 8, minor: 1 }, true],
    ["ffmpeg version 8.0.1 Copyright", { major: 8, minor: 0 }, false],
    ["ffmpeg version 6.1.1-3ubuntu5 Copyright", { major: 6, minor: 1 }, false],
    ["ffmpeg version N-112233-gabcdef Copyright", null, true],
    ["", null, true],
  ])("%j → %j (soportada: %s)", (output, version, supported) => {
    expect(parseFfmpegVersion(output)).toEqual(version);
    expect(isSupportedFfmpeg(parseFfmpegVersion(output))).toBe(supported);
  });

  it("solo mira la primera línea", () => {
    expect(parseFfmpegVersion("algo\nffmpeg version 9.0 Copyright")).toBeNull();
  });
});
