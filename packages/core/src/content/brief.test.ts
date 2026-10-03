import { describe, expect, it } from "vitest";
import {
  contentBrokerFixture,
  contentDefinitionsFixture,
  contentListingFixture,
} from "../testing/index.js";
import { buildContentBrief } from "./brief.js";
import { buildContentPrompt } from "./prompt.js";

const broker = contentBrokerFixture();
const definitions = contentDefinitionsFixture();

describe("buildContentBrief", () => {
  it("arma los datos del aviso con formato chileno y la marca y el tono del corredor", () => {
    const brief = buildContentBrief(contentListingFixture(), definitions, broker);

    expect(brief).toMatchObject({
      operation: "sale",
      propertyType: "Departamento",
      comuna: "Ñuñoa",
      sectorReference: "Cerca de Plaza Inventada",
      price: "UF 5.800",
      commonExpenses: "$120.000",
      usefulArea: 72.5,
      bedrooms: 3,
      bathrooms: 2,
      parking: 1,
      highlights: "Terraza con vista despejada y cocina remodelada",
      availability: "Inmediata",
      amenities: ["Quincho", "Gimnasio"],
      rentalRequirements: null,
      broker: {
        brandName: "Inventada Propiedades",
        tone: "Cercano y profesional",
        fixedHashtags: ["#InventadaPropiedades", "#propiedades"],
      },
    });
    expect(brief.features).toEqual([
      { key: "gastos_comunes_clp", label: "Gastos comunes", value: "$120.000" },
      { key: "sup_util_m2", label: "Superficie útil", value: "72,5 m²" },
      { key: "sup_total_m2", label: "Superficie total", value: "80 m²" },
      { key: "dormitorios", label: "Dormitorios", value: "3" },
      { key: "banos", label: "Baños", value: "2" },
      { key: "estacionamientos", label: "Estacionamientos", value: "1" },
      { key: "bodegas", label: "Bodegas", value: "1" },
      { key: "orientacion", label: "Orientación", value: "Norte" },
      { key: "amoblado", label: "Amoblado", value: "No" },
    ]);
  });

  it("nunca lleva notas internas, _extra, campos sin definición, links ni el contacto", () => {
    const listing = contentListingFixture();
    const brief = buildContentBrief(listing, definitions, broker);
    // Lo que ve la IA: el brief entero y la petición que se arma con él.
    const seen = `${JSON.stringify(brief)}\n${buildContentPrompt(brief).prompt}`;

    for (const hidden of [
      "Dueño acepta ofertas", // internal_notes
      "comision",
      "2% más IVA", // _extra
      "sin_definicion",
      "clave suelta", // campo sin definición
      "video.example.com",
      "tour.example.com", // links
      "publicar_en",
      "Portal Inmobiliario", // a qué canales va: no es del aviso
      "+56 9 1111 2222",
      "contacto@inventada.example",
      "inventada.propiedades",
      "inventada.example", // contacto del corredor
    ]) {
      expect(seen).not.toContain(hidden);
    }
  });

  it("sin show_exact_address no lleva la dirección ni el número de unidad", () => {
    const brief = buildContentBrief(contentListingFixture(), definitions, broker);
    const seen = `${JSON.stringify(brief)}\n${buildContentPrompt(brief).prompt}`;

    expect(brief.address).toBeNull();
    expect(brief.unitNumber).toBeNull();
    expect(seen).not.toContain("Calle Inventada");
    expect(seen).not.toContain("Depto 506");
  });

  it("con show_exact_address lleva la dirección y el número de unidad", () => {
    const listing = contentListingFixture({ showExactAddress: true });
    const brief = buildContentBrief(listing, definitions, broker);

    expect(brief.address).toBe("Calle Inventada 1234");
    expect(brief.unitNumber).toBe("Depto 506");
    expect(buildContentPrompt(brief).prompt).toContain("Calle Inventada 1234");
  });

  it("un campo que el corredor desactivó no llega a la IA", () => {
    const disabled = {
      ...definitions.find((def) => def.key === "sector_referencia"),
      id: "def-broker-sector",
      brokerId: broker.id,
      active: false,
    } as (typeof definitions)[number];
    const brief = buildContentBrief(contentListingFixture(), [...definitions, disabled], broker);

    expect(brief.sectorReference).toBeNull();
    expect(JSON.stringify(brief)).not.toContain("Plaza Inventada");
  });

  it("en arriendo lleva el precio mensual y los requisitos; en venta, no los requisitos", () => {
    const attributes = { ...contentListingFixture().attributes, requisitos_arriendo: "Aval" };
    const rent = buildContentBrief(
      contentListingFixture({
        operation: "rent",
        priceAmount: 650000,
        priceCurrency: "CLP",
        attributes,
      }),
      definitions,
      broker,
    );
    const sale = buildContentBrief(contentListingFixture({ attributes }), definitions, broker);

    expect(rent.price).toBe("$650.000/mes");
    expect(rent.rentalRequirements).toBe("Aval");
    expect(sale.rentalRequirements).toBeNull();
  });

  it("los datos que faltan quedan en null, sin inventarse", () => {
    const brief = buildContentBrief(
      contentListingFixture({ highlights: "  ", attributes: { dormitorios: 0 } }),
      definitions,
      broker,
    );

    expect(brief).toMatchObject({
      sectorReference: null,
      commonExpenses: null,
      usefulArea: null,
      bedrooms: 0,
      bathrooms: null,
      parking: null,
      highlights: null,
      availability: null,
      amenities: [],
    });
    expect(brief.features).toEqual([{ key: "dormitorios", label: "Dormitorios", value: "0" }]);
  });
});
