import { describe, expect, it } from "vitest";
import { parsePublishedUrl } from "../publish/published-url.js";
import { parseTikTokVideoUrl, tiktokVideoUrl } from "./url.js";

// F9-T26: el lector del enlace de TikTok, sin red.

describe("parseTikTokVideoUrl", () => {
  it.each([
    "https://www.tiktok.com/@agentpey/video/7430000000000000001",
    "https://tiktok.com/@agentpey/video/7430000000000000001/",
    "https://m.tiktok.com/@agentpey/video/7430000000000000001?is_from_webapp=1&sender_device=pc",
    "  https://www.tiktok.com/@agentpey/video/7430000000000000001#comentarios  ",
  ])("reconoce %s y devuelve el enlace limpio", (value) => {
    expect(parseTikTokVideoUrl(value)).toEqual({
      username: "agentpey",
      videoId: "7430000000000000001",
      url: "https://www.tiktok.com/@agentpey/video/7430000000000000001",
    });
  });

  it("acepta usuarios con punto y guion bajo", () => {
    expect(parseTikTokVideoUrl("https://www.tiktok.com/@vinny.corredor_cl/video/123").url).toBe(
      tiktokVideoUrl("vinny.corredor_cl", "123"),
    );
  });

  it.each([
    "https://vm.tiktok.com/ZMabcdef/",
    "https://vt.tiktok.com/ZSabcdef/",
    "https://www.tiktok.com/t/ZTabcdef/",
  ])("un enlace corto (%s) pide el largo", (value) => {
    expect(() => parseTikTokVideoUrl(value)).toThrowError(/enlace corto/);
  });

  it.each([
    "http://www.tiktok.com/@agentpey/video/1",
    "https://www.tiktok.com/@agentpey",
    "https://www.tiktok.com/@agentpey/photo/1",
    "https://tiktok.com.evil.test/@agentpey/video/1",
    "https://user:clave@www.tiktok.com/@agentpey/video/1",
    "https://www.tiktok.com:8443/@agentpey/video/1",
    "no es un enlace",
  ])("rechaza %s con PUBLISHED_URL_INVALID, sin repetirlo", (value) => {
    let caught: unknown;
    try {
      parseTikTokVideoUrl(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "PUBLISHED_URL_INVALID",
      details: { platform: "tiktok" },
    });
    expect((caught as Error).message).not.toContain(value.trim());
  });
});

describe("parsePublishedUrl con TikTok", () => {
  it("usa el id del video como external_id", () => {
    expect(
      parsePublishedUrl("tiktok", "https://www.tiktok.com/@agentpey/video/7430000000000000001?x=1"),
    ).toEqual({
      externalId: "7430000000000000001",
      url: "https://www.tiktok.com/@agentpey/video/7430000000000000001",
    });
  });

  it("rechaza el enlace de otra red", () => {
    expect(() => parsePublishedUrl("tiktok", "https://www.instagram.com/p/abc/")).toThrowError(
      expect.objectContaining({ code: "PUBLISHED_URL_INVALID" }),
    );
  });
});
