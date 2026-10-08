import { describe, expect, it } from "vitest";
import type { PublishBrokerContact } from "../ports/publisher.js";
import { type PortalReadinessListing, portalReadiness } from "./readiness.js";

const BROKER: PublishBrokerContact = {
  name: "Corredora",
  email: "c@corredor.test",
  whatsapp: "+56 9 1234 5678",
};

/** Un departamento en arriendo completo: lo más exigente (nota §12.1). */
const listing = (overrides: Partial<PortalReadinessListing> = {}): PortalReadinessListing => ({
  operation: "rent",
  propertyType: "Departamento",
  region: "Metropolitana",
  comuna: "Ñuñoa",
  address: "Av. Irarrázaval 1234",
  showExactAddress: false,
  priceAmount: 650000,
  priceCurrency: "CLP",
  attributes: {
    dormitorios: 2,
    banos: 1,
    estacionamientos: 1,
    bodegas: 0,
    sup_util_m2: 60,
    sup_total_m2: 65,
    gastos_comunes_clp: 0,
    amoblado: false,
    acepta_mascotas: "No",
  },
  ...overrides,
});

const fields = (result: ReturnType<typeof portalReadiness>) =>
  result.ready ? [] : result.issues.map((item) => [item.code, item.field]);

describe("portalReadiness", () => {
  it("un aviso completo está listo (los ceros cuentan como dato: 0 bodegas, 0 de gastos)", () => {
    expect(portalReadiness(listing(), BROKER)).toEqual({ ready: true });
  });

  it.each([
    ["sup_total_m2"],
    ["sup_util_m2"],
    ["dormitorios"],
    ["banos"],
    ["estacionamientos"],
    ["bodegas"],
    ["gastos_comunes_clp"],
    ["amoblado"],
    ["acepta_mascotas"],
  ])("arriendo de departamento sin %s: lo pide", (field) => {
    const attributes = { ...listing().attributes };
    delete attributes[field];

    expect(fields(portalReadiness(listing({ attributes }), BROKER))).toEqual([
      ["PORTAL_FIELD_MISSING", field],
    ]);
  });

  it("en venta no pide mascotas, amoblado, bodegas ni gastos comunes", () => {
    const result = portalReadiness(
      listing({
        operation: "sale",
        priceAmount: 5800.5,
        priceCurrency: "UF",
        attributes: {
          dormitorios: 2,
          banos: 1,
          estacionamientos: 1,
          sup_util_m2: 60,
          sup_total_m2: 65,
        },
      }),
      BROKER,
    );
    expect(result).toEqual({ ready: true });
  });

  it("un terreno solo pide la superficie total", () => {
    expect(
      fields(portalReadiness(listing({ propertyType: "Terreno", attributes: {} }), BROKER)),
    ).toEqual([["PORTAL_FIELD_MISSING", "sup_total_m2"]]);
  });

  it("«A consultar» en mascotas: pide elegir en arriendo; en venta no importa", () => {
    const attributes = { ...listing().attributes, acepta_mascotas: "A consultar" };
    expect(fields(portalReadiness(listing({ attributes }), BROKER))).toEqual([
      ["PORTAL_PETS_UNDECIDED", "acepta_mascotas"],
    ]);
    expect(portalReadiness(listing({ attributes, operation: "sale" }), BROKER)).toEqual({
      ready: true,
    });
  });

  it("sin WhatsApp o con uno que no se lee: lo pide (no es un campo del aviso)", () => {
    expect(fields(portalReadiness(listing(), { ...BROKER, whatsapp: null }))).toEqual([
      ["PORTAL_WHATSAPP_MISSING", null],
    ]);
    expect(fields(portalReadiness(listing(), { ...BROKER, whatsapp: "  " }))).toEqual([
      ["PORTAL_WHATSAPP_MISSING", null],
    ]);
    expect(fields(portalReadiness(listing(), { ...BROKER, whatsapp: "+54 11 1234 5678" }))).toEqual(
      [["PORTAL_WHATSAPP_INVALID", null]],
    );
  });

  it("con la dirección visible, exige la dirección; oculta, no", () => {
    expect(
      fields(portalReadiness(listing({ address: null, showExactAddress: true }), BROKER)),
    ).toEqual([["PORTAL_FIELD_MISSING", "direccion"]]);
    expect(portalReadiness(listing({ address: null, showExactAddress: false }), BROKER)).toEqual({
      ready: true,
    });
  });

  it("tipo, operación, ubicación y precio: lo que falta o no sirve, sin datos del aviso en el mensaje", () => {
    const result = portalReadiness(
      listing({
        propertyType: "Galpón",
        operation: null,
        region: null,
        comuna: null,
        priceAmount: 650000.5,
      }),
      BROKER,
    );
    expect(fields(result)).toEqual([
      ["PORTAL_FIELD_MISSING", "operacion"],
      ["PORTAL_TYPE_UNSUPPORTED", "tipo"],
      ["PORTAL_FIELD_MISSING", "region"],
      ["PORTAL_FIELD_MISSING", "comuna"],
      ["PORTAL_PRICE_INVALID", "precio"],
    ]);
    expect(JSON.stringify(result)).not.toContain("Galpón");
    expect(fields(portalReadiness(listing({ propertyType: null }), BROKER))).toEqual([
      ["PORTAL_FIELD_MISSING", "tipo"],
    ]);
    expect(fields(portalReadiness(listing({ priceAmount: 0 }), BROKER))).toEqual([
      ["PORTAL_PRICE_INVALID", "precio"],
    ]);
  });

  it.each([
    ["dormitorios", "2"],
    ["sup_total_m2", true],
    ["amoblado", "Sí"],
    ["acepta_mascotas", "Tal vez"],
    ["gastos_comunes_clp", Number.NaN],
  ])(
    "un dato con el tipo equivocado (%s = %j) cuenta como faltante, como en buildPortalItem",
    (field, value) => {
      const attributes = { ...listing().attributes, [field]: value };
      expect(fields(portalReadiness(listing({ attributes }), BROKER))).toEqual([
        ["PORTAL_FIELD_MISSING", field],
      ]);
    },
  );

  it("un precio en UF que redondea a 0, o infinito, no sirve", () => {
    for (const priceAmount of [0.004, Number.POSITIVE_INFINITY]) {
      expect(
        fields(portalReadiness(listing({ priceAmount, priceCurrency: "UF" }), BROKER)),
      ).toEqual([["PORTAL_PRICE_INVALID", "precio"]]);
    }
  });

  it("un dato con otro tipo (texto vacío) cuenta como faltante; un campo renombrado también", () => {
    const attributes = { ...listing().attributes, sup_total_m2: "" };
    delete (attributes as Record<string, unknown>).dormitorios;
    expect(
      fields(portalReadiness(listing({ attributes: { ...attributes, dorms: 2 } }), BROKER)),
    ).toEqual([
      ["PORTAL_FIELD_MISSING", "dormitorios"],
      ["PORTAL_FIELD_MISSING", "sup_total_m2"],
    ]);
  });
});
