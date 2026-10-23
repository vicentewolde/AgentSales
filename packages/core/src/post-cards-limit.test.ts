import { describe, expect, it, vi } from "vitest";

// F9.5-T25: los topes extremos de una red (hoy ninguna admite menos de 4 imágenes). Se baja el de X
// para probar que el mazo respeta un tope de 1 (solo la portada) y de 2 (portada y cierre).

const limits = vi.hoisted(() => ({ x: 1 }));

vi.mock("./social/networks.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./social/networks.js")>();
  return {
    ...original,
    get X_MAX_IMAGES() {
      return limits.x;
    },
  };
});

const { describeCardPlan, postCardPlan } = await import("./post-cards.js");

const BRAND = { brandName: "AgentPey", instagramHandle: "agentpey", website: null };
const post = {
  id: "p1",
  topic: "Cómo fijar el precio",
  kind: "carousel" as const,
  platforms: null,
};
const contents = [
  { platform: "x" as const, language: "es" as const, body: "- Uno primero\n- Dos después" },
];

describe("tope extremo de una red", () => {
  it("con un tope de 1, solo la portada", () => {
    limits.x = 1;
    const plan = postCardPlan(post, contents, BRAND);
    expect(plan.cards).toEqual([
      { role: "cover", text: "Cómo fijar el precio", detail: null, position: 1, total: 1 },
    ]);
    expect(describeCardPlan(plan, "carousel")).toBe(
      "1 tarjeta: X admite hasta 1 imagen por post; solo la portada, del texto en español.",
    );
  });

  it("con un tope de 2, portada y cierre", () => {
    limits.x = 2;
    const plan = postCardPlan(post, contents, BRAND);
    expect(plan.cards.map((card) => card.role)).toEqual(["cover", "closing"]);
    expect(plan.cards.every((card) => card.total === 2)).toBe(true);
  });
});
