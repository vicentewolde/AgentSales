import { describe, expect, it } from "vitest";
import {
  PORTAL_ATTRIBUTE_FIELDS,
  portalCategoryPath,
  portalFieldHasValue,
  portalPetsAnswer,
  portalPrice,
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

describe("obligatorios sin catálogo por tipo y operación (las hojas de usados, nota §12.1)", () => {
  const HOME_RENT = ["WAREHOUSES", "FURNISHED", "IS_SUITABLE_FOR_PETS"];
  const BUILT = ["FULL_BATHROOMS", "PARKING_LOTS", "COVERED_AREA", "TOTAL_AREA"];
  it.each([
    ["Departamentos", "sale", ["BEDROOMS", ...BUILT]],
    ["Departamentos", "rent", ["BEDROOMS", ...BUILT, "MAINTENANCE_FEE", ...HOME_RENT]],
    ["Casas", "sale", ["BEDROOMS", ...BUILT]],
    ["Casas", "rent", ["BEDROOMS", ...BUILT, ...HOME_RENT]],
    ["Oficinas", "sale", BUILT],
    ["Oficinas", "rent", BUILT],
    ["Locales", "sale", BUILT],
    ["Locales", "rent", BUILT],
    ["Bodegas", "sale", BUILT],
    ["Bodegas", "rent", BUILT],
    ["Parcelas", "sale", ["BEDROOMS", ...BUILT]],
    ["Parcelas", "rent", ["BEDROOMS", ...BUILT]],
    ["Terrenos", "sale", ["TOTAL_AREA"]],
    ["Terrenos", "rent", ["TOTAL_AREA"]],
    ["Estacionamientos", "sale", ["TOTAL_AREA"]],
    ["Estacionamientos", "rent", ["TOTAL_AREA"]],
  ] as const)("%s en %s", (type, operation, expected) => {
    const required = PORTAL_ATTRIBUTE_FIELDS.filter((entry) => entry.required(type, operation)).map(
      (entry) => entry.attribute,
    );
    expect([...required].sort()).toEqual([...expected].sort());
  });
});

describe("portalFieldHasValue (la misma regla en las dos revisiones)", () => {
  it.each([
    ["number", 2, true],
    ["number", 0, true],
    ["number", "2", false],
    ["number", Number.NaN, false],
    ["area", 72.5, true],
    ["area", true, false],
    ["fee", Number.POSITIVE_INFINITY, false],
    ["yes_no", false, true],
    ["yes_no", "Sí", false],
    ["pets", "No", true],
    ["pets", "A consultar", false],
    ["pets", "Tal vez", false],
    ["facing", "Nororiente", true],
    ["facing", "Arriba", false],
    ["age", 2015, true],
    ["age", null, false],
  ] as const)("%s con %j → %s", (kind, value, has) => {
    expect(portalFieldHasValue(kind, value)).toBe(has);
  });
});

describe("portalPrice", () => {
  it.each([
    [5800.456, "UF", { price: 5800.46, currency: "CLF" }],
    [0.004, "UF", null],
    [Number.POSITIVE_INFINITY, "UF", null],
    [650000, "CLP", { price: 650000, currency: "CLP" }],
    [650000.5, "CLP", null],
    [0, "CLP", null],
    [-1, "CLP", null],
  ] as const)("%s %s → %j", (amount, currency, price) => {
    expect(portalPrice(amount, currency)).toEqual(price);
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
