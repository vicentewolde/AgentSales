import { describe, expect, it } from "vitest";
import {
  defaultChosen,
  languagesByPlatform,
  platformsWithSeveral,
  publishRows,
} from "./publish-choice.js";

const text = (id: string, platform: "x" | "instagram", language: "es" | "en") => ({
  id,
  platform,
  language,
  status: "approved" as const,
});

const contents = [
  text("x-en", "x", "en"),
  text("x-es", "x", "es"),
  text("ig-es", "instagram", "es"),
  text("ig-en", "instagram", "en"),
];

describe("publishRows y defaultChosen", () => {
  it("un renglón por texto aprobado, español antes que inglés, y marcado solo el primero de cada red", () => {
    const rows = publishRows(["x", "instagram"], contents, []);
    expect(rows.map((row) => row.contentId)).toEqual(["x-es", "x-en", "ig-es", "ig-en"]);
    const chosen = defaultChosen(rows, contents, []);
    expect(chosen).toEqual(["x-es", "ig-es"]);
    expect(platformsWithSeveral(rows, chosen)).toEqual([]);
    expect(platformsWithSeveral(rows, [...chosen, "ig-en"])).toEqual(["instagram"]);
    expect([...languagesByPlatform(rows, [...chosen, "ig-en"])]).toEqual([
      ["x", ["es"]],
      ["instagram", ["es", "en"]],
    ]);
  });

  it("si un idioma de la red ya está programado, el otro no se marca solo y el programado no tiene renglón", () => {
    const publications = [
      {
        contentId: "x-es",
        platform: "x" as const,
        language: "es" as const,
        status: "scheduled" as const,
      },
    ];
    const rows = publishRows(["x"], contents, publications);
    expect(rows.map((row) => row.contentId)).toEqual(["x-en"]);
    expect(defaultChosen(rows, contents, publications)).toEqual([]);
  });
});
