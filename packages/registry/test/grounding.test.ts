import { describe, expect, it } from "vitest";
import { ungroundedTerms } from "../src/gateway/answer.js";
import type { VisibleFact } from "../src/gateway/policy.js";
import { sameNumbers } from "../src/gateway/translate.js";

const fact = (statement: string, id = "f1"): VisibleFact => ({
  id,
  statement,
  provenance: "broker_declared",
  evidence: "declared by the broker; not independently verified",
});

describe("number words and ordinals count as numbers", () => {
  it("a number word cannot stand for a different number", () => {
    expect(ungroundedTerms("The flat has three bedrooms.", [fact("2 bedrooms")])).toContain("3");
    expect(ungroundedTerms("It includes ten parking spaces.", [fact("1 parking space")])).toContain(
      "10",
    );
    expect(ungroundedTerms("There are twelve floors.", [fact("Floor 12")])).toEqual([]); // twelve = 12: the fact says 12
  });
  it("an ordinal cannot stand for a different floor", () => {
    expect(ungroundedTerms("It is on the first floor.", [fact("Floor 12")])).toContain("1");
    expect(
      ungroundedTerms("The second bedroom has a closet.", [fact("Bedrooms have built-in closet")]),
    ).toContain("2");
  });
  it("digits and words agree on both sides, so honest answers are not refused", () => {
    expect(
      ungroundedTerms("A table with 4 chairs.", [fact("Wooden dining table with four chairs")]),
    ).toEqual([]);
    expect(
      ungroundedTerms("A table with four chairs.", [fact("Wooden dining table with four chairs")]),
    ).toEqual([]);
    expect(ungroundedTerms("The flat has two bedrooms.", [fact("2 bedrooms")])).toEqual([]);
    expect(ungroundedTerms("The flat has 2 bedrooms.", [fact("2 bedrooms")])).toEqual([]);
  });
  it("the digit rule still holds", () => {
    expect(ungroundedTerms("The flat has 5 bedrooms.", [fact("2 bedrooms")])).toEqual(["5"]);
  });
});

describe("translation guard reads number words in both languages", () => {
  it("does not let 'four' become 'cinco', or 42000 become 24000", () => {
    expect(sameNumbers("A table with four chairs.", "Una mesa con cinco sillas.")).toBe(false);
    expect(sameNumbers("A table with four chairs.", "Una mesa con cuatro sillas.")).toBe(true);
    expect(sameNumbers("Common expenses are 42000 pesos.", "Los gastos son 24000 pesos.")).toBe(
      false,
    );
  });
  it("accepts a translation that turns 'one' into the article 'un', and refuses one that adds or drops a figure", () => {
    expect(sameNumbers("One parking space is included.", "Incluye un estacionamiento.")).toBe(true);
    expect(sameNumbers("Pets are allowed.", "Se aceptan dos mascotas.")).toBe(false);
    expect(sameNumbers("It is on floor 12.", "Está en el piso.")).toBe(false);
  });
});
