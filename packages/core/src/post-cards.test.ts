import { describe, expect, it } from "vitest";
import type { Language, PostPlatform } from "./enums.js";
import { isAppError } from "./errors.js";
import {
  cardImageLimit,
  cardPoints,
  cardSource,
  cardSourceText,
  cardText,
  describeCardPlan,
  POST_CARDS,
  postCardDeck,
  postCardPlan,
} from "./post-cards.js";

// F9.5-T25: qué dice cada tarjeta. Todo sale del post (tema y texto) o de la marca; nada se inventa.

const BRAND = { brandName: "AgentPey", instagramHandle: "agentpey", website: null };
const post = (kind: "image" | "carousel" | "video", platforms: PostPlatform[] | null = null) => ({
  id: "p1",
  topic: "Cómo fijar el precio",
  kind,
  platforms,
});
const text = (platform: PostPlatform, body: string, language: Language = "es") => ({
  platform,
  language,
  body,
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
      cardSourceText([text("x", "de X"), text("instagram", "  "), text("linkedin", "de LinkedIn")]),
    ).toBe("de LinkedIn");
    expect(cardSourceText([])).toBe("");
  });

  it("usa un solo texto, en el idioma principal, sin mezclar idiomas ni redes", () => {
    const four = [
      text("x", "X en español", "es"),
      text("x", "X in English", "en"),
      text("discord", "Discord en español", "es"),
      text("discord", "Discord in English", "en"),
    ];
    expect(cardSource(four, "es")).toEqual({
      body: "Discord en español",
      platform: "discord",
      language: "es",
    });
    expect(cardSource(four, "en").body).toBe("Discord in English");
  });

  it("si el idioma principal no tiene texto, usa un solo texto del primer idioma que sí", () => {
    const onlyEnglish = [text("x", "X in English", "en"), text("discord", "Discord", "en")];
    expect(cardSource(onlyEnglish, "es")).toEqual({
      body: "Discord",
      platform: "discord",
      language: "en",
    });
  });
});

describe("cardImageLimit", () => {
  it("toma el límite más estricto de las redes del post", () => {
    expect(cardImageLimit("carousel", ["x", "discord"])).toEqual({ max: 4, platform: "x" });
    expect(cardImageLimit("carousel", ["instagram", "x"])).toEqual({ max: 4, platform: "x" });
    expect(cardImageLimit("carousel", ["instagram", "discord"])).toEqual({
      max: 10,
      platform: "instagram",
    });
    expect(cardImageLimit("carousel", ["discord"])).toEqual({ max: 10, platform: "discord" });
  });

  it("sin redes con tope (o sin redes), el máximo general; fuera de un carrusel no hay tope", () => {
    expect(cardImageLimit("carousel", ["linkedin"])).toEqual({ max: 10, platform: null });
    expect(cardImageLimit("carousel", [])).toEqual({ max: 10, platform: null });
    expect(cardImageLimit("video", ["x"])).toEqual({ max: 10, platform: null });
  });
});

describe("postCardDeck", () => {
  const contents = [text("instagram", "- Uno primero\n- Dos después")];

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

describe("postCardPlan: el caso de las 10 tarjetas", () => {
  const points = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => `- ${prefix} punto ${i + 1}`).join("\n");
  // Un carrusel para X y Discord, con español e inglés en cada una (los cuatro textos).
  const four = [
    text("x", points(6, "X es"), "es"),
    text("x", points(6, "X en"), "en"),
    text("discord", points(6, "Discord es"), "es"),
    text("discord", points(6, "Discord en"), "en"),
  ];

  it("X y Discord, cuatro textos: 4 tarjetas (portada, 2 puntos y cierre) de un solo idioma", () => {
    const plan = postCardPlan(post("carousel", ["x", "discord"]), four, BRAND, { language: "es" });
    expect(plan.cards).toHaveLength(4);
    expect(plan.cards.map((card) => card.role)).toEqual(["cover", "point", "point", "closing"]);
    expect(plan.cards.every((card) => card.total === 4)).toBe(true);
    // Un solo texto: el de Discord en español (el primero en el orden), sin mezclar con X ni inglés.
    const pointTexts = plan.cards.filter((c) => c.role === "point").map((c) => c.text);
    expect(pointTexts).toEqual(["Discord es punto 1", "Discord es punto 2"]);
    expect(plan.limit).toEqual({ max: 4, platform: "x" });
    expect(plan.limited).toBe(true);
    expect(plan.source).toEqual({ platform: "discord", language: "es" });
    expect(describeCardPlan(plan, "carousel")).toBe(
      "4 tarjetas: X admite hasta 4 imágenes por post; portada, 2 puntos y cierre, del texto en español.",
    );
  });

  it("el idioma principal manda: en inglés, los puntos salen del texto en inglés", () => {
    const plan = postCardPlan(post("carousel", ["x", "discord"]), four, BRAND, { language: "en" });
    expect(plan.cards.filter((c) => c.role === "point").map((c) => c.text)).toEqual([
      "Discord en punto 1",
      "Discord en punto 2",
    ]);
  });

  it("Instagram admite hasta 10: portada, 8 puntos y cierre", () => {
    const plan = postCardPlan(
      post("carousel", ["instagram", "discord"]),
      [text("instagram", points(12, "IG"))],
      BRAND,
      { language: "es" },
    );
    expect(plan.cards).toHaveLength(10);
    expect(plan.limit).toEqual({ max: 10, platform: "instagram" });
    expect(describeCardPlan(plan, "carousel")).toContain("Instagram admite hasta 10 imágenes");
  });

  it("con poco texto salen menos tarjetas que el tope y no se nombra la red", () => {
    const plan = postCardPlan(
      post("carousel", ["x"]),
      [text("x", "- Uno primero\n- Dos después")],
      BRAND,
    );
    expect(plan.cards).toHaveLength(4);
    const short = postCardPlan(post("carousel", ["x"]), [text("x", "- Solo uno aquí")], BRAND);
    expect(short.cards).toHaveLength(3);
    expect(describeCardPlan(short, "carousel")).toBe(
      "3 tarjetas: portada, 1 punto y cierre, del texto en español.",
    );
  });

  it("un video no se limita por las imágenes de X: hasta 8 puntos", () => {
    const plan = postCardPlan(post("video", ["x"]), [text("x", points(9, "V"))], BRAND);
    expect(plan.cards).toHaveLength(10);
  });

  it("las redes salen de los textos que hay, aunque el post no fije redes", () => {
    const plan = postCardPlan(post("carousel"), [text("x", points(6, "X"))], BRAND);
    expect(plan.cards).toHaveLength(4);
    // Sin textos ni redes fijadas, no hay tope de red: solo portada y cierre porque no hay puntos.
    const empty = postCardPlan(post("carousel"), [], BRAND);
    expect(empty.cards).toHaveLength(2);
    expect(empty.limit).toEqual({ max: 10, platform: null });
  });
});
