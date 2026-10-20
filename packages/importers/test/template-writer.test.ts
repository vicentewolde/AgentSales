import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type Broker, buildListingValidator, parseBrokerSheet } from "@agentsales/core";
import { REAL_ESTATE_FIELD_DEFINITIONS, TEMPLATE_COLUMNS } from "@agentsales/db";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { writeBrokerTemplate } from "../src/template-writer.js";
import { readListingsWorkbook } from "../src/xlsx-reader.js";

// F7-T14 (spec F7 §4.6): la planilla de un corredor, de ida y vuelta con el lector.

const TEMPLATE = fileURLToPath(
  new URL("../../../data/plantillas/plantilla_propiedades.xlsx", import.meta.url),
);

const validator = buildListingValidator(
  REAL_ESTATE_FIELD_DEFINITIONS.map((def, index) => ({ ...def, id: `seed-${index}` })),
);

const broker: Broker = {
  id: "00000000-0000-4000-8000-0000000000b1",
  slug: "marca-inventada",
  name: "Persona Inventada",
  brandName: "Marca Inventada",
  logoMediaId: "logo-1",
  primaryColor: "#1F4E79",
  secondaryColor: "#F2A900",
  whatsapp: "+56 9 1111 2222",
  email: "contacto@inventada.example",
  instagramHandle: "marca.inventada",
  website: "https://inventada.example",
  tone: "Cercano y profesional",
  fixedHashtags: ["#marcainventada", "#propiedades"],
  autoPublish: false,
  operatorOwned: false,
  llmMonthlyCapUsd: null,
  kind: "broker",
};

const load = async (bytes: Uint8Array | string) => {
  const workbook = new ExcelJS.Workbook();
  if (typeof bytes === "string") await workbook.xlsx.readFile(bytes);
  else await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  return workbook;
};

describe("writeBrokerTemplate", () => {
  it("leída de vuelta da el corredor, sin logo y sin errores, y solo la fila EJEMPLO (ignorada)", async () => {
    const bytes = await writeBrokerTemplate(TEMPLATE, broker);
    const read = await readListingsWorkbook(bytes);
    const parsed = parseBrokerSheet(read.broker ?? {});
    expect(parsed).toMatchObject({ ok: true, logoFile: null, warnings: [] });
    if (!parsed.ok) throw new Error("la hoja Corredor no se leyó");
    const {
      id: _id,
      logoMediaId: _l,
      autoPublish: _a,
      operatorOwned: _o,
      llmMonthlyCapUsd: _c,
      kind: _k,
      ...data
    } = broker;
    expect(parsed.data).toEqual(data);

    expect(read.headers).toEqual([...TEMPLATE_COLUMNS]);
    expect(validator.checkHeaders(read.headers)).toEqual({
      unknown: [],
      missing: [],
      duplicated: [],
    });
    expect(read.rows.map((row) => row.raw.id_propiedad)).toEqual(["EJEMPLO"]);
    expect(read.rows.every((row) => validator.isIgnored(row.raw))).toBe(true);
  });

  it("con la fila de ejemplo copiada como P001, la propiedad es válida", async () => {
    const workbook = await load(await writeBrokerTemplate(TEMPLATE, broker));
    const sheet = workbook.getWorksheet("Propiedades");
    if (!sheet) throw new Error("sin hoja Propiedades");
    const example = sheet.getRow(2);
    const row = sheet.getRow(3);
    example.eachCell((cell, column) => {
      row.getCell(column).value = cell.value;
    });
    row.getCell(1).value = "P001";
    row.commit();
    const read = await readListingsWorkbook(new Uint8Array(await workbook.xlsx.writeBuffer()));
    const filled = read.rows.find((candidate) => candidate.raw.id_propiedad === "P001");
    if (!filled) throw new Error("no se leyó P001");
    expect(validator.isIgnored(filled.raw)).toBe(false);
    expect(validator.validate(filled.raw)).toMatchObject({
      ok: true,
      data: { core: { externalRef: "P001", operation: "sale", priceAmount: 5800 } },
    });
  });

  it("conserva las hojas, las listas de opciones y las validaciones de la plantilla", async () => {
    const original = await load(TEMPLATE);
    const written = await load(await writeBrokerTemplate(TEMPLATE, broker));
    expect(written.worksheets.map((sheet) => sheet.name)).toEqual(
      original.worksheets.map((sheet) => sheet.name),
    );
    const values = (workbook: ExcelJS.Workbook, name: string) =>
      workbook.getWorksheet(name)?.getSheetValues();
    expect(values(written, "Listas")).toEqual(values(original, "Listas"));
    expect(values(written, "Instrucciones")).toEqual(values(original, "Instrucciones"));
    // Lo que vale de cada validación: el tipo, la lista y si admite vacío (exceljs omite al
    // escribir las banderas que valen falso por defecto).
    const validations = (workbook: ExcelJS.Workbook) => {
      const model: Record<string, { type: string; formulae: unknown; allowBlank?: boolean }> =
        // biome-ignore lint/suspicious/noExplicitAny: `dataValidations` no está en los tipos de exceljs
        (workbook.getWorksheet("Propiedades") as any)?.dataValidations?.model ?? {};
      return Object.fromEntries(
        Object.entries(model).map(([cell, rule]) => [
          cell,
          { type: rule.type, formulae: rule.formulae, allowBlank: rule.allowBlank },
        ]),
      );
    };
    expect(validations(written)).toEqual(validations(original));
    expect(Object.keys(validations(original)).length).toBeGreaterThan(0);
  });

  it("un corredor sin opcionales deja esas celdas vacías y se lee igual", async () => {
    const bare: Broker = {
      ...broker,
      whatsapp: null,
      email: null,
      instagramHandle: null,
      website: null,
      tone: null,
      fixedHashtags: [],
    };
    const parsed = parseBrokerSheet(
      (await readListingsWorkbook(await writeBrokerTemplate(TEMPLATE, bare))).broker ?? {},
    );
    expect(parsed).toMatchObject({
      ok: true,
      data: { whatsapp: null, email: null, instagramHandle: null, fixedHashtags: [] },
    });
  });

  it("también recibe la plantilla como bytes (lo mismo que con la ruta)", async () => {
    const bytes = new Uint8Array(await readFile(TEMPLATE));
    const read = await readListingsWorkbook(await writeBrokerTemplate(bytes, broker));
    expect(parseBrokerSheet(read.broker ?? {})).toMatchObject({ ok: true });
  });
});
