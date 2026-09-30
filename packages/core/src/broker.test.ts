import { describe, expect, it } from "vitest";
import { type Broker, brokerDiffers, parseBrokerSheet, slugify } from "./broker.js";

/** Hoja Corredor sintética (datos inventados). */
const SHEET = {
  nombre_corredor: "Persona Inventada",
  nombre_marca: "Marca Inventada Propiedades",
  logo: "logo.png",
  color_primario: "#1f3a5f",
  color_secundario: "",
  whatsapp: "+56 9 0000 0000",
  email: "contacto@example.cl",
  instagram: "@marca.inventada",
  sitio_web: "example.cl",
  tono: "Cercano",
  hashtags_fijos: "#uno  #dos",
};

describe("parseBrokerSheet", () => {
  it("mapea la hoja con la tabla de §4.2", () => {
    expect(parseBrokerSheet(SHEET)).toEqual({
      ok: true,
      data: {
        slug: "marca-inventada-propiedades",
        name: "Persona Inventada",
        brandName: "Marca Inventada Propiedades",
        primaryColor: "#1F3A5F",
        secondaryColor: "#1F3A5F",
        whatsapp: "+56 9 0000 0000",
        email: "contacto@example.cl",
        instagramHandle: "marca.inventada",
        website: "example.cl",
        tone: "Cercano",
        fixedHashtags: ["#uno", "#dos"],
      },
      logoFile: "logo.png",
      warnings: [],
    });
  });

  it("compara las etiquetas sin mayúsculas ni tildes y avisa las repetidas y desconocidas", () => {
    const result = parseBrokerSheet({
      "Nombre_Corredor ": "Persona",
      nombre_marca: "Marca",
      color_primario: "#000000",
      NOMBRE_MARCA: "Otra",
      Fax: "123",
    });
    expect(result).toMatchObject({ ok: true, data: { name: "Persona", brandName: "Marca" } });
    expect(result.warnings).toEqual([
      "Campo repetido en la hoja Corredor: «NOMBRE_MARCA» (vale el primero)",
      "Campo desconocido en la hoja Corredor: «Fax»",
    ]);
  });

  it("hashtags_fijos: separa por espacios o comas, agrega # y quita repetidos", () => {
    const result = parseBrokerSheet({ ...SHEET, hashtags_fijos: "casa, #venta #casa ##depto" });
    expect(result).toMatchObject({
      ok: true,
      data: { fixedHashtags: ["#casa", "#venta", "#depto"] },
    });
  });

  it("con errores igual informa el slug que habría tenido, para el reporte", () => {
    const result = parseBrokerSheet({ nombre_marca: "Marca Inventada", color_primario: "azul" });
    expect(result).toMatchObject({ ok: false, slug: "marca-inventada" });
  });

  it("un slug explícito (--broker) gana sobre el de la marca", () => {
    expect(parseBrokerSheet(SHEET, { slug: "mi-corredor" })).toMatchObject({
      ok: true,
      data: { slug: "mi-corredor" },
    });
  });

  it("acumula los errores: obligatorios, color y email inválidos", () => {
    const result = parseBrokerSheet({ nombre_marca: "Marca", color_primario: "azul", email: "x" });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((issue) => [issue.column, issue.code])).toEqual([
      ["nombre_corredor", "FIELD_REQUIRED"],
      ["color_primario", "FIELD_VALUE_INVALID"],
      ["email", "FIELD_VALUE_INVALID"],
    ]);
  });

  it("rechaza un slug explícito con formato inválido", () => {
    const result = parseBrokerSheet(SHEET, { slug: "Mi Corredor" });
    expect(result).toMatchObject({ ok: false, issues: [{ column: "broker" }] });
  });

  it("rechaza celdas que no son RawCell", () => {
    const result = parseBrokerSheet({ ...SHEET, tono: { richText: [] } });
    expect(result).toMatchObject({
      ok: false,
      issues: [{ column: "tono", code: "FIELD_VALUE_INVALID" }],
    });
  });
});

describe("slugify y brokerDiffers", () => {
  it("slugify pliega tildes y separa con guiones", () => {
    expect(slugify("  Ñuñoa & Co. Propiedades ")).toBe("nunoa-co-propiedades");
  });

  it("brokerDiffers compara los datos de la hoja, incluidos los hashtags", () => {
    const parsed = parseBrokerSheet(SHEET);
    if (!parsed.ok) throw new Error("hoja inválida");
    const broker: Broker = { ...parsed.data, id: "b1", logoMediaId: null, autoPublish: true };
    expect(brokerDiffers(broker, parsed.data)).toBe(false);
    expect(brokerDiffers(broker, { ...parsed.data, fixedHashtags: ["#uno"] })).toBe(true);
    expect(brokerDiffers(broker, { ...parsed.data, tone: "Formal" })).toBe(true);
  });
});
