import { describe, expect, it } from "vitest";
import { marketplaceReadiness } from "./readiness.js";

const listing = {
  operation: "rent" as const,
  propertyType: "Departamento",
  region: "Región Metropolitana",
  comuna: "Ñuñoa",
  priceAmount: 650_000,
  priceCurrency: "CLP" as const,
  attributes: { dormitorios: 2, banos: 1 },
};

describe("marketplaceReadiness", () => {
  it("un aviso completo con fotos está listo", () => {
    expect(marketplaceReadiness(listing, { photos: 5, ufConfigured: false })).toEqual({
      ready: true,
    });
  });

  it("pide lo que falta, sin inventar (0 dormitorios vale)", () => {
    const result = marketplaceReadiness(
      {
        ...listing,
        operation: null,
        propertyType: null,
        comuna: " ",
        priceAmount: 0,
        attributes: { dormitorios: 0 },
      },
      { photos: 0, ufConfigured: false },
    );
    expect(result.ready).toBe(false);
    expect(result.ready ? [] : result.issues.map((issue) => [issue.code, issue.field])).toEqual([
      ["MARKETPLACE_PHOTOS_MISSING", null],
      ["MARKETPLACE_FIELD_MISSING", "operacion"],
      ["MARKETPLACE_FIELD_MISSING", "tipo"],
      ["MARKETPLACE_FIELD_MISSING", "precio"],
      ["MARKETPLACE_FIELD_MISSING", "banos"],
      ["MARKETPLACE_FIELD_MISSING", "comuna"],
    ]);
  });

  it("en UF necesita el token del Banco Central", () => {
    const uf = { ...listing, priceAmount: 5800, priceCurrency: "UF" as const };
    expect(marketplaceReadiness(uf, { photos: 1, ufConfigured: true })).toEqual({ ready: true });
    expect(marketplaceReadiness(uf, { photos: 1, ufConfigured: false })).toMatchObject({
      ready: false,
      issues: [{ code: "UF_SOURCE_NOT_CONFIGURED", field: null }],
    });
  });
});
