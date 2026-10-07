import { describe, expect, it } from "vitest";
import {
  normalizePortalName,
  normalizePortalRegion,
  PORTAL_LOCATION_ALIASES,
  portalAttributesSchema,
  portalCatalogKeys,
  portalCategorySchema,
} from "./catalog.js";

describe("normalizePortalName", () => {
  it.each([
    ["Ñuñoa", "nunoa"],
    ["  ÑUÑOA ", "nunoa"],
    ["Peñalolén", "penalolen"],
    ["Libertador B. O'Higgins", "libertador b ohiggins"],
    ["O’Higgins", "ohiggins"],
    ["Propiedades   Usadas", "propiedades usadas"],
    ["Viña del Mar", "vina del mar"],
  ])("%s → %s", (name, normalized) => {
    expect(normalizePortalName(name)).toBe(normalized);
  });
});

describe("normalizePortalRegion", () => {
  it.each([
    ["Región Metropolitana", "metropolitana"],
    ["Región de Valparaíso", "valparaiso"],
    ["Región del Libertador General Bernardo O'Higgins", "libertador general bernardo ohiggins"],
    ["Valparaíso", "valparaiso"],
  ])("%s → %s", (name, normalized) => {
    expect(normalizePortalRegion(name)).toBe(normalized);
  });

  it("las llaves de los alias ya están normalizadas (si no, nunca calzarían)", () => {
    for (const key of Object.keys(PORTAL_LOCATION_ALIASES.regions)) {
      expect(normalizePortalRegion(key)).toBe(key);
    }
    for (const key of Object.keys(PORTAL_LOCATION_ALIASES.communes)) {
      expect(normalizePortalName(key)).toBe(key);
    }
  });
});

describe("esquemas del catálogo", () => {
  const category = {
    id: "MLC1472",
    name: "Departamentos",
    childrenCategories: [{ id: "MLC1473", name: "Venta" }],
    settings: {
      listingAllowed: false,
      maxTitleLength: null,
      maxPicturesPerItem: 30,
      maxDescriptionLength: null,
      currencies: null,
      minimumPrice: null,
      maximumPrice: null,
    },
  };

  it("una categoría guardada se lee de vuelta; una con otra forma no", () => {
    expect(portalCategorySchema.parse(category)).toEqual(category);
    expect(portalCategorySchema.safeParse({ ...category, settings: undefined }).success).toBe(
      false,
    );
    expect(portalCategorySchema.safeParse({ ...category, childrenCategories: null }).success).toBe(
      false,
    );
  });

  it("los atributos no se aceptan vacíos", () => {
    expect(portalAttributesSchema.safeParse([]).success).toBe(false);
  });

  it("las claves tienen la forma tipo:id", () => {
    expect(portalCatalogKeys.category("MLC1459")).toBe("category:MLC1459");
    expect(portalCatalogKeys.attributes("MLC1480")).toBe("attributes:MLC1480");
    expect(portalCatalogKeys.location("TUxDUE9IUzFjODg")).toBe("location:TUxDUE9IUzFjODg");
  });
});
