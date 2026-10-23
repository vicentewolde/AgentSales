import { describe, expect, it } from "vitest";
import { isAppError } from "./errors.js";
import { cardPoints, cardSourceText, cardText, POST_CARDS, postCardDeck } from "./post-cards.js";

// F9.5-T25: qué dice cada tarjeta. Todo sale del post (tema y texto) o de la marca; nada se inventa.

const BRAND = { brandName: "AgentPey", instagramHandle: "agentpey", website: null };
const post = (kind: "image" | "carousel" | "video") => ({
  id: "p1",
  topic: "Cómo fijar el precio",
  kind,
});

describe("cardText", () => {
  it("quita emojis y hashtags, y deja tildes y ñ", () => {
    expect(cardText("🏡 Año nuevo,  casa nueva ✨ #inmobiliaria #Chile")).toBe(
      "Año nuevo, casa nueva",
    );
  });
});

describe("cardPoints", () => {
  it("usa las viñetas si hay al menos dos", () => {
    const body =
      "Tres claves:\n- Mira el mercado 📈\n- Revisa los gastos\n1. Pide una tasación\n\n#casa";
    expect(cardPoints(body, "Precio")).toEqual([
      "Mira el mercado",
      "Revisa los gastos",
      "Pide una tasación",
    ]);
  });

  it("sin viñetas usa los párrafos; un solo párrafo, sus oraciones", () => {
    expect(cardPoints("Primero esto.\n\nDespués aquello.", "x")).toEqual([
      "Primero esto.",
      "Después aquello.",
    ]);
    expect(cardPoints("Una idea. Otra idea! ¿Y otra?", "x")).toEqual([
      "Una idea.",
      "Otra idea!",
      "¿Y otra?",
    ]);
  });

  it("no repite el tema ni puntos iguales, corta los largos y respeta el tope", () => {
    const long = `${"palabra ".repeat(40)}final`;
    const body = [
      "- Tema",
      "- Punto",
      "- Punto",
      `- ${long}`,
      ...Array.from({ length: 12 }, (_, i) => `- Extra ${i}`),
    ].join("\n");
    const points = cardPoints(body, "tema");
    expect(points[0]).toBe("Punto");
    expect(points[1]?.length).toBeLessThanOrEqual(POST_CARDS.pointMaxChars);
    expect(points[1]?.endsWith("…")).toBe(true);
    expect(points).toHaveLength(POST_CARDS.maxPoints);
  });
});

describe("cardSourceText", () => {
  it("prefiere Instagram, después LinkedIn, y salta los vacíos", () => {
    expect(
      cardSourceText([
        { platform: "x", body: "de X" },
        { platform: "instagram", body: "  " },
        { platform: "linkedin", body: "de LinkedIn" },
      ]),
    ).toBe("de LinkedIn");
    expect(cardSourceText([])).toBe("");
  });
});

describe("postCardDeck", () => {
  const contents = [{ platform: "instagram" as const, body: "- Uno primero\n- Dos después" }];

  it("imagen: una tarjeta con el tema", () => {
    expect(postCardDeck(post("image"), contents, BRAND)).toEqual([
      { role: "cover", text: "Cómo fijar el precio", detail: null, position: 1, total: 1 },
    ]);
  });

  it("carrusel: portada, un punto por tarjeta y el cierre con la marca y su cuenta", () => {
    const deck = postCardDeck(post("carousel"), contents, BRAND);
    expect(
      deck.map((card) => [card.role, card.text, card.detail, `${card.position}/${card.total}`]),
    ).toEqual([
      ["cover", "Cómo fijar el precio", null, "1/4"],
      ["point", "Uno primero", null, "2/4"],
      ["point", "Dos después", null, "3/4"],
      ["closing", "AgentPey", "@agentpey", "4/4"],
    ]);
  });

  it("sin cuenta de Instagram, el cierre usa el sitio; sin nada, sin contacto", () => {
    const site = postCardDeck(post("carousel"), [], {
      brandName: "M",
      instagramHandle: null,
      website: "https://agentpey.com/",
    });
    expect(site.at(-1)?.detail).toBe("agentpey.com");
    const none = postCardDeck(post("carousel"), [], { ...BRAND, instagramHandle: null });
    expect(none.at(-1)?.detail).toBeNull();
  });

  it("video sin texto redactado: POST_IMAGE_NEEDS_TEXT (no inventa puntos)", () => {
    let error: unknown;
    try {
      postCardDeck(post("video"), [], BRAND);
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error) && error.code).toBe("POST_IMAGE_NEEDS_TEXT");
    expect(postCardDeck(post("video"), contents, BRAND)).toHaveLength(4);
  });
});
