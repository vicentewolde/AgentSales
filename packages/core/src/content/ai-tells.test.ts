import { describe, expect, it } from "vitest";
import { aiTellMessage, findAiTells, foldKeepingLength } from "./ai-tells.js";

// Las muletillas de texto escrito por IA (spec F9.5, D6).

const texts = (text: string) => findAiTells(text).map((tell) => tell.text);
const kinds = (text: string) => findAiTells(text).map((tell) => tell.kind);

describe("findAiTells en español", () => {
  it("encuentra las frases hechas, sin mirar mayúsculas ni tildes", () => {
    expect(texts("¡Descubre este departamento en el corazón de Ñuñoa!")).toEqual([
      "descubre",
      "en el corazón de",
    ]);
    expect(texts("SUMERGETE en la calma. Sin duda, tu nuevo hogar te espera.")).toEqual([
      "sumérgete",
      "sin duda",
      "te espera",
    ]);
    expect(texts("Un oasis de tranquilidad, ideal para quienes buscan espacio.")).toEqual([
      "un oasis",
      "ideal para quienes buscan",
    ]);
    expect(texts("No es solo una casa, es un hogar.")).toEqual(["no es solo X, es Y"]);
    expect(texts("No es solo una casa. Es el lugar de tus sueños.")).toEqual([
      "no es solo X, es Y",
      "de tus sueños",
    ]);
    expect(texts("¿Sabías que el 80 % de los arriendos se cierra en una semana?")).toEqual([
      "¿sabías que…?",
    ]);
  });

  it("no marca palabras que solo contienen la frase ni usos normales", () => {
    expect(findAiTells("Descubrimos que el sector tiene buena locomoción.")).toEqual([]);
    expect(findAiTells("Lo dudamos: sin dudarlo, es una buena opción.")).toEqual([]);
    expect(findAiTells("No solo tiene terraza, sino también bodega.")).toEqual([]);
    expect(findAiTells("Departamento de 3 dormitorios con cocina, living y comedor.")).toEqual([]);
    expect(findAiTells("Esperamos tu visita el sábado.")).toEqual([]);
    expect(findAiTells("Avenida Revolución, a tan solo 5 minutos del metro.")).toEqual([]);
  });

  it("más de 2 signos de exclamación, no 2", () => {
    expect(findAiTells("¡Hola! ¡Ya está disponible!")).toEqual([]);
    expect(findAiTells("¡Hola! ¡Ya está! ¡Escríbenos!")).toEqual([
      { kind: "exclamations", text: "3 signos de exclamación" },
    ]);
  });

  it("el guion largo como pausa, no al inicio de una línea ni en un rango", () => {
    expect(kinds("La terraza — con vista al cerro — da al oriente.")).toEqual(["dash"]);
    expect(kinds("La terraza—con vista al cerro—da al oriente.")).toEqual(["dash"]);
    expect(findAiTells("Lista:\n— terraza\n— bodega")).toEqual([]);
    expect(findAiTells("Horario de 9 – 18 h y de 9-13 h.")).toEqual([]);
    // El guion corto con espacios separa rangos: no se marca.
    expect(findAiTells("Atención de Lunes – Viernes.")).toEqual([]);
    expect(findAiTells("Lo que importa – la luz de la tarde.")).toEqual([]);
  });

  it("tres adjetivos seguidos, con el trozo original", () => {
    expect(findAiTells("Un espacio amplio, luminoso y acogedor.")).toEqual([
      { kind: "triad", text: "amplio, luminoso y acogedor" },
    ]);
    expect(findAiTells("Casas cómodas, prácticas y seguras.")).toEqual([
      { kind: "triad", text: "cómodas, prácticas y seguras" },
    ]);
    // Sustantivos o dos adjetivos no son una tríada.
    expect(findAiTells("Cocina, living y comedor.")).toEqual([]);
    expect(findAiTells("Amplio y luminoso, con bodega.")).toEqual([]);
  });

  it("emojis seguidos, no uno suelto ni los del caption que arma el código", () => {
    expect(findAiTells("Lista para mudarse 🔥🔥")).toEqual([{ kind: "emojis", text: "🔥🔥" }]);
    expect(findAiTells("Nueva oficina ✨ 🏡")).toEqual([{ kind: "emojis", text: "✨ 🏡" }]);
    expect(findAiTells("🏢 Departamento en venta · Ñuñoa")).toEqual([]);
    expect(findAiTells("📐 72,5 m² útiles · 🛏 3 dorm · 🛁 2 baños\n💰 UF 5.800")).toEqual([]);
    expect(findAiTells("Marca® y Producto™ ©")).toEqual([]);
  });
});

describe("findAiTells en inglés", () => {
  it("encuentra las frases hechas", () => {
    expect(texts("Discover a home nestled in the heart of the city.")).toEqual([
      "discover",
      "nestled",
      "in the heart of",
    ]);
    expect(texts("Look no further: unlock seamless onboarding.")).toEqual([
      "look no further",
      "unlock",
      "seamless",
    ]);
    expect(texts("In today’s fast-paced world, this is a game-changer.")).toEqual([
      "game-changer",
      "in today's fast-paced world",
    ]);
    expect(texts("It's not just a tool, it's a partner. Let's dive into it.")).toEqual([
      "it's not just X, it's Y",
      "dive into",
    ]);
    expect(texts("Experience the difference. We elevate every listing.")).toEqual([
      "Experience…",
      "elevate",
    ]);
  });

  it("no marca usos normales ni palabras que solo contienen la frase", () => {
    expect(findAiTells("We discovered three things this week.")).toEqual([]);
    expect(findAiTells("An elevated lot with years of experience in sales.")).toEqual([]);
    expect(findAiTells("It is not just about price; buyers ask about light.")).toEqual([]);
    expect(findAiTells("Not only fast, but reliable.")).toEqual([]);
    expect(findAiTells("We haven't decided yet.")).toEqual([]);
    expect(findAiTells("Haven Street, near the park.")).toEqual([]);
    expect(texts("A haven for remote work.")).toEqual(["a haven"]);
  });

  it("tres adjetivos seguidos, con coma de Oxford o sin ella", () => {
    expect(findAiTells("Simple, fast, and reliable.")).toEqual([
      { kind: "triad", text: "Simple, fast, and reliable" },
    ]);
    expect(kinds("A bright, airy and modern loft.")).toEqual(["triad"]);
  });
});

describe("aiTellMessage", () => {
  it("dice todas las muletillas en un mensaje", () => {
    const tells = findAiTells("¡Sin duda! ¡Te espera! ¡Amplio, luminoso y moderno! 🔥🔥");
    expect(aiTellMessage(tells)).toBe(
      "Suena escrito por IA: «sin duda», «te espera», 3 signos de exclamación, " +
        "tres adjetivos seguidos («Amplio, luminoso y moderno»), emojis seguidos (🔥🔥). " +
        "Cámbialo por algo concreto o dilo más simple",
    );
  });
});

describe("foldKeepingLength", () => {
  it("pliega sin cambiar el largo", () => {
    const text = "Ñuñoa — Corazón 🔥 It’s";
    const folded = foldKeepingLength(text);
    expect(folded).toBe("nunoa — corazon 🔥 it's");
    expect(folded).toHaveLength(text.length);
  });
});
