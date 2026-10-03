import { describe, expect, it } from "vitest";
import {
  contentBrokerFixture,
  contentDefinitionsFixture,
  contentListingFixture,
} from "../testing/index.js";
import { buildContentBrief } from "./brief.js";
import { coverFacts, reelOverlayData, slideBrand, specSheetData } from "./slides-data.js";

const broker = contentBrokerFixture();
const briefOf = (overrides = {}) =>
  buildContentBrief(contentListingFixture(overrides), contentDefinitionsFixture(), broker);

describe("datos de las plantillas", () => {
  it("la portada: m² útiles, dormitorios y baños; sin los que faltan o son 0", () => {
    expect(coverFacts(briefOf())).toEqual([
      { icon: "area", text: "72,5 m²" },
      { icon: "bed", text: "3 dorm" },
      { icon: "bath", text: "2 baños" },
    ]);
    const studio = briefOf({ attributes: { dormitorios: 0, banos: 1 } });
    expect(coverFacts(studio)).toEqual([{ icon: "bath", text: "1 baño" }]);
  });

  it("la ficha: filas de la lista fija en su orden, sin dirección ni campos sueltos", () => {
    const sheet = specSheetData(
      briefOf({ showExactAddress: true }),
      broker,
      slideBrand(broker, null),
    );

    expect(sheet.rows.map((row) => [row.icon, row.label, row.value])).toEqual([
      ["area", "Superficie útil", "72,5 m²"],
      ["area", "Superficie total", "80 m²"],
      ["bed", "Dormitorios", "3"],
      ["bath", "Baños", "2"],
      ["parking", "Estacionamientos", "1"],
      ["storage", "Bodegas", "1"],
      ["compass", "Orientación", "Norte"],
      ["furniture", "Amoblado", "No"],
    ]);
    expect(sheet).toMatchObject({
      commonExpenses: "$120.000",
      availability: "Inmediata",
      contact: { whatsapp: "+56 9 1111 2222", instagramHandle: "inventada.propiedades" },
    });
    expect(JSON.stringify(sheet)).not.toMatch(/Calle Inventada|Depto 506/);
  });

  it("el texto del reel, y un aviso sin tipo usa «Propiedad»", () => {
    expect(reelOverlayData(briefOf({ propertyType: null, operation: "rent" }))).toMatchObject({
      operation: "rent",
      propertyType: "Propiedad",
      comuna: "Ñuñoa",
    });
  });
});
