import { describe, expect, it } from "vitest";
import {
  escapeLinkedInText,
  joinedPostText,
  LINKEDIN_RESERVED_CHARACTERS,
  linkKey,
  linksIn,
  POST_TEXT_LIMITS,
  postTextLength,
  xWeightedLength,
} from "./networks.js";

describe("escapeLinkedInText", () => {
  it("escapa con una barra cada uno de los 15 caracteres reservados de LinkedIn", () => {
    expect(LINKEDIN_RESERVED_CHARACTERS).toHaveLength(15);
    for (const char of LINKEDIN_RESERVED_CHARACTERS) {
      expect(escapeLinkedInText(`a${char}b`)).toBe(`a\\${char}b`);
    }
  });

  it("escapa todos juntos en una pasada, la barra una sola vez", () => {
    expect(escapeLinkedInText("|{}@[]()<>#\\*_~")).toBe(
      "\\|\\{\\}\\@\\[\\]\\(\\)\\<\\>\\#\\\\\\*\\_\\~",
    );
    expect(escapeLinkedInText("Precio (UF) #1")).toBe("Precio \\(UF\\) \\#1");
  });

  it("no toca el resto: tildes, eñes, emojis, saltos de línea y puntuación común", () => {
    const text = "Ñuñoa, ¿qué tal? Sí: 50% más… 🚀\nOtra línea - con guion.";
    expect(escapeLinkedInText(text)).toBe(text);
  });
});

describe("xWeightedLength", () => {
  it("las letras con tilde pesan 1, como las demás latinas", () => {
    expect(xWeightedLength("árbol ñandú")).toBe(11);
  });

  it("cada URL pesa 23, sea cual sea su largo, también sin http", () => {
    expect(xWeightedLength("https://agentpey.com/un/camino/muy/largo/de/verdad")).toBe(23);
    expect(xWeightedLength("Mira agentpey.com")).toBe(5 + 23);
    expect(xWeightedLength("a www.agentpey.cl.")).toBe(2 + 23 + 1);
  });

  it("cada emoji pesa 2, con sus modificadores y uniones", () => {
    expect(xWeightedLength("🚀")).toBe(2);
    expect(xWeightedLength("👍🏽")).toBe(2);
    expect(xWeightedLength("👨‍👩‍👧")).toBe(2);
    expect(xWeightedLength("🇨🇱")).toBe(2);
  });

  it("los caracteres CJK pesan 2", () => {
    expect(xWeightedLength("日本")).toBe(4);
  });

  it("normaliza a NFC: una tilde combinada cuenta como una letra", () => {
    expect(xWeightedLength("é")).toBe(1);
  });
});

describe("postTextLength", () => {
  const text = { body: "Hola (mundo)", hashtags: ["#uno", "#dos"] };

  it("suma los hashtags en un párrafo aparte, como el caption de Instagram", () => {
    expect(joinedPostText(text)).toBe("Hola (mundo)\n\n#uno #dos");
    expect(postTextLength("instagram", text)).toEqual({
      length: 23,
      max: POST_TEXT_LIMITS.instagram,
    });
    expect(postTextLength("discord", { body: "solo", hashtags: [] })).toEqual({
      length: 4,
      max: 2000,
    });
  });

  it("LinkedIn mide con los escapes (lo más largo, mientras no se verifique)", () => {
    // `(`, `)` y los dos `#` suman cuatro barras.
    expect(postTextLength("linkedin", text)).toEqual({ length: 27, max: 3000 });
  });

  it("X mide ponderado", () => {
    expect(postTextLength("x", { body: "🚀 agentpey.com", hashtags: [] })).toEqual({
      length: 2 + 1 + 23,
      max: 280,
    });
  });

  it("cada red tiene su máximo", () => {
    expect(POST_TEXT_LIMITS).toEqual({
      instagram: 2200,
      x: 280,
      linkedin: 3000,
      discord: 2000,
      tiktok: 2200,
    });
  });
});

describe("linksIn y linkKey", () => {
  it("reconoce enlaces con http, con www y dominios sueltos, sin la puntuación final", () => {
    expect(
      linksIn("Ve a https://agentpey.com/precios, o www.vinny.dev. También agentpey.cl/blog!"),
    ).toEqual(["https://agentpey.com/precios", "www.vinny.dev", "agentpey.cl/blog"]);
  });

  it("no confunde palabras ni cifras con enlaces", () => {
    expect(linksIn("Fin de la frase.Otra cosa, 5.800 y 2,5")).toEqual([]);
  });

  it("compara sin protocolo, www, mayúsculas ni la barra final", () => {
    expect(linkKey("https://www.AgentPey.com/")).toBe(linkKey("agentpey.com"));
  });
});
