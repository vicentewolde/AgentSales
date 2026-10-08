import { describe, expect, it } from "vitest";
import {
  PORTAL_ATTRIBUTE_FIELDS,
  portalCategoryPath,
  portalPetsAnswer,
  portalPropertyType,
  portalSellerContact,
  portalWhatsappParts,
} from "./fields.js";

describe("portalCategoryPath (nombres reales de ml:smoke, nota §12.1)", () => {
  it.each([
    ["Departamento", "sale", ["Departamentos", "Venta", "Propiedades usadas"]],
    ["Departamento", "rent", ["Departamentos", "Arriendo", "Propiedades usadas"]],
    ["Casa", "sale", ["Casas", "Venta", "Propiedades usadas"]],
    ["Casa", "rent", ["Casas", "Arriendo", "Propiedades usadas"]],
    ["Oficina", "sale", ["Oficinas", "Venta", "Propiedades usadas"]],
    ["Oficina", "rent", ["Oficinas", "Arriendo", "Propiedades usadas"]],
    ["Parcela", "sale", ["Parcelas", "Venta", "Propiedades usadas"]],
    ["Parcela", "rent", ["Parcelas", "Arriendo"]],
    ["Local comercial", "sale", ["Locales", "Venta"]],
    ["Local comercial", "rent", ["Locales", "Arriendo"]],
    ["Terreno", "sale", ["Terrenos", "Venta"]],
    ["Bodega", "rent", ["Bodegas", "Arriendo"]],
    ["Estacionamiento", "sale", ["Estacionamientos", "Venta"]],
  ] as const)("%s en %s → %j", (type, operation, path) => {
    expect(portalCategoryPath(type, operation)).toEqual(path);
  });

  it("sin mayúsculas ni tildes; un tipo que no se publica o sin operación es null", () => {
    expect(portalCategoryPath("  LOCAL COMERCIAL ", "rent")).toEqual(["Locales", "Arriendo"]);
    expect(portalCategoryPath("Galpón", "sale")).toBeNull();
    expect(portalCategoryPath("constructor", "sale")).toBeNull();
    expect(portalCategoryPath(null, "sale")).toBeNull();
    expect(portalCategoryPath("Casa", null)).toBeNull();
    expect(portalPropertyType("departamento")).toBe("Departamentos");
  });
});

describe("tabla de atributos", () => {
  it("un campo por atributo, sin repetir, y nunca uno que completa la categoría", () => {
    const attributes = PORTAL_ATTRIBUTE_FIELDS.map((entry) => entry.attribute);
    expect(new Set(attributes).size).toBe(attributes.length);
    expect(attributes).not.toContain("PROPERTY_TYPE");
    expect(attributes).not.toContain("OPERATION");
    expect(attributes).not.toContain("CMG_SITE");
  });

  it("los obligatorios por tipo y operación calzan con lo leído en Mercado Libre", () => {
    const required = (
      type: Parameters<(typeof PORTAL_ATTRIBUTE_FIELDS)[number]["required"]>[0],
      operation: "sale" | "rent",
    ) =>
      PORTAL_ATTRIBUTE_FIELDS.filter((entry) => entry.required(type, operation)).map(
        (entry) => entry.attribute,
      );
    expect(required("Departamentos", "sale")).toEqual([
      "BEDROOMS",
      "FULL_BATHROOMS",
      "PARKING_LOTS",
      "COVERED_AREA",
      "TOTAL_AREA",
    ]);
    expect(required("Departamentos", "rent")).toEqual([
      "BEDROOMS",
      "FULL_BATHROOMS",
      "PARKING_LOTS",
      "WAREHOUSES",
      "COVERED_AREA",
      "TOTAL_AREA",
      "MAINTENANCE_FEE",
      "FURNISHED",
      "IS_SUITABLE_FOR_PETS",
    ]);
    expect(required("Casas", "rent")).not.toContain("MAINTENANCE_FEE");
    expect(required("Terrenos", "sale")).toEqual(["TOTAL_AREA"]);
    expect(required("Estacionamientos", "rent")).toEqual(["TOTAL_AREA"]);
    expect(required("Oficinas", "sale")).toEqual([
      "FULL_BATHROOMS",
      "PARKING_LOTS",
      "COVERED_AREA",
      "TOTAL_AREA",
    ]);
  });
});

describe("portalPetsAnswer", () => {
  it.each([
    ["Sí", "si"],
    ["si", "si"],
    ["No", "no"],
    ["A consultar", "undecided"],
    ["", null],
    [true, null],
    [null, null],
  ] as const)("%j → %j", (value, answer) => {
    expect(portalPetsAnswer(value)).toBe(answer);
  });
});

describe("portalWhatsappParts y portalSellerContact (nota §4.2)", () => {
  it.each([
    ["+56 9 1234 5678", { countryCode2: "56", phone2: "912345678" }],
    ["+56 9 850 90820", { countryCode2: "56", phone2: "985090820" }],
    ["56912345678", { countryCode2: "56", phone2: "912345678" }],
    ["9 1234 5678", { countryCode2: "56", phone2: "912345678" }],
    ["+54 9 11 1234 5678", null],
    ["1234", null],
    [null, null],
  ] as const)("%j → %j", (whatsapp, parts) => {
    expect(portalWhatsappParts(whatsapp)).toEqual(parts);
  });

  it("solo dígitos, con el nombre y el correo si los hay; sin WhatsApp, null", () => {
    expect(
      portalSellerContact({
        name: " Corredora ",
        email: "c@corredor.test",
        whatsapp: "+56 9 1234 5678",
      }),
    ).toEqual({
      contact: "Corredora",
      email: "c@corredor.test",
      countryCode2: "56",
      phone2: "912345678",
    });
    expect(portalSellerContact({ name: "", email: " ", whatsapp: "912345678" })).toEqual({
      contact: null,
      email: null,
      countryCode2: "56",
      phone2: "912345678",
    });
    expect(portalSellerContact({ name: "C", email: null, whatsapp: null })).toBeNull();
  });
});
