import { describe, expect, it } from "vitest";
import type { PublishInput, PublishListing } from "../ports/publisher.js";
import {
  MARKETPLACE_PROPERTY_TYPE_KEYS,
  marketplaceFormPlan,
  marketplaceOperationOption,
  marketplacePropertyTypeOption,
} from "./fields.js";

const listing: PublishListing = {
  id: "l1",
  externalRef: "P001",
  operation: "rent",
  propertyType: "Departamento",
  region: "Región Metropolitana",
  comuna: "Ñuñoa",
  address: "Av. Irarrázaval 1234",
  unitNumber: "502",
  showExactAddress: false,
  priceAmount: 18,
  priceCurrency: "UF",
  attributes: { dormitorios: 2, banos: 1, sup_util_m2: 54.5 },
};

const input = (overrides: Partial<PublishInput> = {}): PublishInput => ({
  publicationId: "p1",
  platform: "fb_marketplace",
  format: "post",
  title: " Departamento en Ñuñoa ",
  caption: "Texto aprobado de Marketplace.",
  media: [],
  listing,
  priceClp: 740_270,
  uf: { date: "2026-10-12", value: "41126.12" },
  ...overrides,
});

// La tabla sale del formulario real «Nueva vivienda» (`fb:smoke --menus`, 2026-10-13).
describe("tabla de campos de Marketplace", () => {
  it("el formulario es solo de arriendo: la venta no tiene opción", () => {
    expect(marketplaceOperationOption("rent")).toBe("Alquiler");
    expect(marketplaceOperationOption("sale")).toBeNull();
    expect(marketplaceOperationOption(null)).toBeNull();
  });

  it("traduce el tipo a las opciones reales (sin importar mayúsculas ni tildes)", () => {
    expect(marketplacePropertyTypeOption("DEPARTAMENTO")).toBe("Apartamento o piso");
    expect(marketplacePropertyTypeOption("Casa")).toBe("Casa");
    expect(marketplacePropertyTypeOption("Bodega")).toBeNull();
    expect(marketplacePropertyTypeOption("Oficina")).toBeNull();
    expect(marketplacePropertyTypeOption("Castillo")).toBeNull();
    expect(MARKETPLACE_PROPERTY_TYPE_KEYS).toContain("local comercial");
  });

  it("arma el plan: precio en pesos, superficie en pies cuadrados, sin título y sin la dirección si no se muestra", () => {
    expect(marketplaceFormPlan(input())).toEqual({
      propertyType: "Apartamento o piso",
      priceClp: 740_270,
      bedrooms: 2,
      bathrooms: 1,
      // 54,5 m² × 10,7639 = 586,6 → 587
      areaSquareFeet: 587,
      location: { comuna: "Ñuñoa", region: "Región Metropolitana" },
      address: null,
      description: "Texto aprobado de Marketplace.",
    });
  });

  it("con show_exact_address lleva la calle y el número, sin la unidad (el mapa no la entiende)", () => {
    const plan = marketplaceFormPlan(input({ listing: { ...listing, showExactAddress: true } }));
    expect(plan.address).toBe("Av. Irarrázaval 1234");
  });

  it("sin superficie la deja vacía; nunca inventa un dato", () => {
    const plan = marketplaceFormPlan(
      input({ listing: { ...listing, attributes: { dormitorios: 0, banos: 1 } } }),
    );
    expect(plan).toMatchObject({ bedrooms: 0, areaSquareFeet: null });
    expect(
      marketplaceFormPlan(
        input({
          listing: { ...listing, attributes: { dormitorios: 1, banos: 1, sup_util_m2: 0 } },
        }),
      ).areaSquareFeet,
    ).toBeNull();
    expect(() =>
      marketplaceFormPlan(input({ listing: { ...listing, attributes: { dormitorios: 2 } } })),
    ).toThrow(expect.objectContaining({ code: "MARKETPLACE_NOT_READY", retriable: false }));
    expect(() => marketplaceFormPlan(input({ priceClp: undefined }))).toThrow(
      expect.objectContaining({ code: "MARKETPLACE_NOT_READY" }),
    );
  });

  it("un tipo sin opción da MARKETPLACE_TYPE_UNSUPPORTED y una venta MARKETPLACE_OPERATION_UNSUPPORTED, no reintentables", () => {
    expect(() =>
      marketplaceFormPlan(input({ listing: { ...listing, propertyType: "Terreno" } })),
    ).toThrow(expect.objectContaining({ code: "MARKETPLACE_TYPE_UNSUPPORTED", retriable: false }));
    expect(() =>
      marketplaceFormPlan(input({ listing: { ...listing, operation: "sale" } })),
    ).toThrow(
      expect.objectContaining({ code: "MARKETPLACE_OPERATION_UNSUPPORTED", retriable: false }),
    );
  });
});
