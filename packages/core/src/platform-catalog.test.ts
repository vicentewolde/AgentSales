import { describe, expect, it } from "vitest";
import { platformCatalogEntrySchema } from "./platform-catalog.js";

describe("entrada del catálogo (ADR-0015)", () => {
  const entry = {
    platform: "portal_inmobiliario",
    key: "location:TUxDUE9IUzFjODg",
    data: { id: "TUxDUE9IUzFjODg", name: "Libertador B. O'Higgins", cities: [] },
    fetchedAt: new Date("2026-10-06T12:00:00Z"),
  };

  it("acepta las claves de categoría, atributos y ubicación", () => {
    expect(platformCatalogEntrySchema.parse(entry)).toEqual(entry);
    for (const key of ["category:MLC1459", "attributes:MLC157520", "location:CL"]) {
      expect(platformCatalogEntrySchema.safeParse({ ...entry, key }).success).toBe(true);
    }
  });

  it("rechaza una clave sin tipo o con espacios, y datos que no son JSON", () => {
    for (const key of ["MLC1459", "category:", "category:MLC 1459", "Category:MLC1459", ""]) {
      expect(platformCatalogEntrySchema.safeParse({ ...entry, key }).success).toBe(false);
    }
    expect(platformCatalogEntrySchema.safeParse({ ...entry, data: undefined }).success).toBe(false);
    expect(platformCatalogEntrySchema.safeParse({ ...entry, data: new Date() }).success).toBe(
      false,
    );
  });
});
