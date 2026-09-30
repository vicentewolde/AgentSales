import { fileURLToPath } from "node:url";
import { buildListingValidator } from "@agentsales/core";
import { REAL_ESTATE_FIELD_DEFINITIONS, TEMPLATE_COLUMNS } from "@agentsales/db";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { readListingsWorkbook } from "../src/xlsx-reader.js";

/** La plantilla oficial (en git, sin datos reales): el formato que el lector debe entender. */
const TEMPLATE = fileURLToPath(
  new URL("../../../data/plantillas/plantilla_propiedades.xlsx", import.meta.url),
);

const validator = buildListingValidator(
  REAL_ESTATE_FIELD_DEFINITIONS.map((def, index) => ({ ...def, id: `seed-${index}` })),
);

describe("readListingsWorkbook con la plantilla real", () => {
  it("sus encabezados son exactamente TEMPLATE_COLUMNS", async () => {
    const workbook = await readListingsWorkbook(TEMPLATE);
    expect(workbook.headers).toEqual([...TEMPLATE_COLUMNS]);
    expect(validator.checkHeaders(workbook.headers)).toEqual({
      unknown: [],
      missing: [],
      duplicated: [],
    });
  });

  it("devuelve solo la fila EJEMPLO (fila 2): las vacías con formato no son datos", async () => {
    const { rows } = await readListingsWorkbook(TEMPLATE);
    expect(rows.map((row) => row.rowNumber)).toEqual([2]);
    expect(rows[0]?.raw).toMatchObject({ id_propiedad: "EJEMPLO", precio: 5800, moneda: "UF" });
  });

  it("la fila EJEMPLO es válida para el validador del seed, que la marca como ignorada", async () => {
    const [example] = (await readListingsWorkbook(TEMPLATE)).rows;
    if (!example) throw new Error("la plantilla no trae la fila EJEMPLO");
    expect(validator.isIgnored(example.raw)).toBe(true);
    expect(validator.validate(example.raw)).toMatchObject({
      ok: true,
      data: { core: { externalRef: "EJEMPLO", operation: "sale", priceAmount: 5800 } },
    });
  });

  it("la hoja Corredor sin completar da broker null", async () => {
    expect((await readListingsWorkbook(TEMPLATE)).broker).toBeNull();
  });
});

describe("diccionario de la hoja Instrucciones", () => {
  it("la columna Obligatorio coincide con required del seed (carpeta_medios es opcional)", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(TEMPLATE);
    const sheet = workbook.getWorksheet("Instrucciones");
    const dictionary = new Map<string, boolean>();
    sheet?.eachRow((row) => {
      const field = row.getCell(2).value;
      const required = row.getCell(3).value;
      if (typeof field === "string" && (TEMPLATE_COLUMNS as readonly string[]).includes(field)) {
        dictionary.set(field, required === "Sí");
      }
    });
    expect([...dictionary.keys()]).toEqual([...TEMPLATE_COLUMNS]);
    for (const def of REAL_ESTATE_FIELD_DEFINITIONS) {
      expect(dictionary.get(def.key), def.key).toBe(def.required);
    }
  });
});
