import { describe, expect, it } from "vitest";
import { isAppError } from "./errors.js";
import {
  isLinkedInPostUrn,
  linkedinAccountMetaSchema,
  linkedinPersonUrn,
  linkedinPostUrl,
  parseLinkedInPostUrl,
} from "./linkedin.js";
import { isManualAccount } from "./platform-account.js";
import { parsePublishedUrl } from "./publish/published-url.js";

// F9-T15: el lector del enlace de un post de LinkedIn (sin red) y lo que core sabe de la cuenta.

const errorOf = (run: () => unknown) => {
  try {
    run();
    return null;
  } catch (caught) {
    return caught;
  }
};

describe("parseLinkedInPostUrl", () => {
  it("la barra del navegador: /feed/update/<urn>, con o sin / final, consulta o fragmento", () => {
    const urn = "urn:li:share:7380000000000000000";
    const clean = `https://www.linkedin.com/feed/update/${urn}/`;
    for (const pasted of [
      clean,
      ` https://www.linkedin.com/feed/update/${urn} `,
      `${clean}?utm_source=share&utm_medium=member_desktop`,
      `${clean}#comentarios`,
      `https://linkedin.com/feed/update/${urn}/`,
      `https://cl.linkedin.com/feed/update/${urn}/`,
      "https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7380000000000000000/",
      `https://www.linkedin.com/embed/feed/update/${urn}`,
    ]) {
      expect(parseLinkedInPostUrl(pasted)).toEqual({ urn, url: clean });
    }
  });

  it("deja el tipo del URN en su forma canónica (share, ugcPost, activity)", () => {
    expect(
      parseLinkedInPostUrl("https://www.linkedin.com/feed/update/urn:li:UGCPOST:123/").urn,
    ).toBe("urn:li:ugcPost:123");
    expect(
      parseLinkedInPostUrl("https://www.linkedin.com/feed/update/urn:li:activity:456").urn,
    ).toBe("urn:li:activity:456");
  });

  it("«Copiar enlace a la publicación»: /posts/…-activity-<número>-<sufijo>", () => {
    expect(
      parseLinkedInPostUrl(
        "https://www.linkedin.com/posts/vicente-wolde_arriendo-activity-post-activity-7381234567890123456-AbCd?utm_source=share&utm_medium=member_ios",
      ),
    ).toEqual({
      urn: "urn:li:activity:7381234567890123456",
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7381234567890123456/",
    });
    expect(
      parseLinkedInPostUrl(
        "https://www.linkedin.com/posts/agentpey_hola-share-7381234567890123456/",
      ).urn,
    ).toBe("urn:li:share:7381234567890123456");
  });

  it("otra cosa es PUBLISHED_URL_INVALID, sin repetir lo recibido", () => {
    for (const value of [
      "https://lnkd.in/abc123",
      "https://www.linkedin.com/in/vicente-wolde/",
      "https://www.linkedin.com/feed/",
      "https://www.linkedin.com/feed/update/urn:li:person:abc/",
      "https://www.linkedin.com.evil.com/feed/update/urn:li:share:1/",
      "http://www.linkedin.com/feed/update/urn:li:share:1/",
      "https://evil.com/?u=https://www.linkedin.com/feed/update/urn:li:share:1/",
      "urn:li:share:1",
      "",
    ]) {
      const error = errorOf(() => parseLinkedInPostUrl(value));
      expect(isAppError(error) && error.code).toBe("PUBLISHED_URL_INVALID");
      if (value !== "") expect((error as Error).message).not.toContain(value);
    }
  });

  it("parsePublishedUrl de LinkedIn usa el lector: el external_id es el URN", () => {
    expect(
      parsePublishedUrl("linkedin", "https://www.linkedin.com/feed/update/urn:li:share:9/?x=1"),
    ).toEqual({
      externalId: "urn:li:share:9",
      url: "https://www.linkedin.com/feed/update/urn:li:share:9/",
    });
    const error = errorOf(() => parsePublishedUrl("linkedin", "https://www.linkedin.com/x"));
    expect(isAppError(error) && error.code).toBe("PUBLISHED_URL_INVALID");
  });
});

describe("LinkedIn en core", () => {
  it("el URN del autor, el enlace del post y qué es un URN de post", () => {
    expect(linkedinPersonUrn("abc_DEF-1")).toBe("urn:li:person:abc_DEF-1");
    expect(linkedinPostUrl("urn:li:share:1")).toBe(
      "https://www.linkedin.com/feed/update/urn:li:share:1/",
    );
    expect(isLinkedInPostUrn("urn:li:share:1")).toBe(true);
    expect(isLinkedInPostUrn("urn:li:ugcPost:1")).toBe(true);
    expect(isLinkedInPostUrn("urn:li:person:1")).toBe(false);
  });

  it("la meta exige el modo; una cuenta de LinkedIn en manual publica a mano", () => {
    const meta = { mode: "manual", scopes: null, connectedAt: "2026-10-20T12:00:00.000Z" };
    expect(linkedinAccountMetaSchema.parse(meta)).toEqual(meta);
    expect(linkedinAccountMetaSchema.safeParse({ ...meta, mode: "auto" }).success).toBe(false);
    expect(isManualAccount({ platform: "linkedin", meta })).toBe(true);
    expect(isManualAccount({ platform: "linkedin", meta: { ...meta, mode: "api" } })).toBe(false);
  });
});
