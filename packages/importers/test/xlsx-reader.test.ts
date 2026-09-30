import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildListingValidator, isAppError } from "@agentsales/core";
import { REAL_ESTATE_FIELD_DEFINITIONS, TEMPLATE_COLUMNS } from "@agentsales/db";
import { describe, expect, it } from "vitest";
import { MAX_DATA_ROWS, MAX_XLSX_BYTES, readListingsWorkbook } from "../src/xlsx-reader.js";
import { buildWorkbook, syntheticRow } from "./workbook.js";

const validator = buildListingValidator(
  REAL_ESTATE_FIELD_DEFINITIONS.map((def, index) => ({ ...def, id: `seed-${index}` })),
);

const BROKER: [string, unknown][] = [
  ["nombre_corredor", "Persona Inventada"],
  ["nombre_marca", "Marca Inventada"],
  ["logo", "logo.png"],
  ["color_primario", "#1F3A5F"],
  ["color_secundario", ""],
  ["hashtags_fijos", "#uno #dos"],
];

async function expectError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(isAppError(error) && error.code, String(error)).toBe(code);
  return error;
}

describe("readListingsWorkbook · fixtures sintéticas", () => {
  it("válida: 3 propiedades con su número de fila y la hoja Corredor", async () => {
    const bytes = await buildWorkbook({
      listings: {
        rows: [
          syntheticRow(),
          syntheticRow({
            id_propiedad: "P002",
            operacion: "Arriendo",
            precio: 650000,
            moneda: "CLP",
          }),
          syntheticRow({ id_propiedad: "P003", tipo: "Casa" }),
        ],
      },
      broker: BROKER,
    });
    const workbook = await readListingsWorkbook(bytes);

    expect(workbook.headers).toEqual([...TEMPLATE_COLUMNS]);
    expect(workbook.rows.map((row) => [row.rowNumber, row.raw.id_propiedad])).toEqual([
      [2, "P001"],
      [3, "P002"],
      [4, "P003"],
    ]);
    for (const row of workbook.rows) expect(validator.validate(row.raw).ok).toBe(true);
    expect(workbook.broker).toEqual({
      nombre_corredor: "Persona Inventada",
      nombre_marca: "Marca Inventada",
      logo: "logo.png",
      color_primario: "#1F3A5F",
      color_secundario: "",
      hashtags_fijos: "#uno #dos",
    });
  });

  it("con errores: el lector no valida, entrega las celdas tal cual al validador", async () => {
    const bytes = await buildWorkbook({
      listings: { rows: [syntheticRow({ precio: "cinco mil", tipo: "Castillo" }), syntheticRow()] },
    });
    const [bad, good] = (await readListingsWorkbook(bytes)).rows;
    expect(bad?.raw).toMatchObject({ precio: "cinco mil", tipo: "Castillo" });
    const result = validator.validate(bad?.raw ?? {});
    expect(result.ok ? [] : result.errors.map((error) => error.column).sort()).toEqual([
      "precio",
      "tipo",
    ]);
    expect(validator.validate(good?.raw ?? {}).ok).toBe(true);
  });

  it("con columnas extra: llegan en headers y en la fila, y el validador las manda a _extra", async () => {
    const headers = [...TEMPLATE_COLUMNS, "Vista al mar"];
    const bytes = await buildWorkbook({
      listings: { headers, rows: [syntheticRow({ "Vista al mar": "Sí" })] },
    });
    const workbook = await readListingsWorkbook(bytes);
    expect(validator.checkHeaders(workbook.headers).unknown).toEqual(["Vista al mar"]);
    const result = validator.validate(workbook.rows[0]?.raw ?? {});
    expect(result).toMatchObject({
      ok: true,
      data: { attributes: { _extra: { "Vista al mar": "Sí" } } },
    });
  });

  it("estilo Google Sheets: todo como texto, TRUE/FALSE y hojas con otro nombre y orden", async () => {
    const asText = syntheticRow({
      precio: "5.800",
      sup_util_m2: "72,5",
      dormitorios: "3",
      gastos_comunes_clp: "$120.000",
      amoblado: "FALSE",
      mostrar_direccion_exacta: "TRUE",
      disponibilidad: "15-11-2026",
    });
    const bytes = await buildWorkbook({
      listings: { rows: [asText] },
      broker: BROKER,
      sheetNames: { listings: "PROPIEDADES", broker: "corredor ", brokerFirst: true },
    });
    const workbook = await readListingsWorkbook(bytes);
    expect(workbook.broker).not.toBeNull();
    expect(validator.validate(workbook.rows[0]?.raw ?? {})).toMatchObject({
      ok: true,
      data: {
        core: { priceAmount: 5800, showExactAddress: true },
        attributes: {
          sup_util_m2: 72.5,
          dormitorios: 3,
          gastos_comunes_clp: 120000,
          amoblado: false,
          disponibilidad: "15-11-2026",
        },
      },
    });
  });

  it("aplana fórmulas, hipervínculos, texto enriquecido, errores y fechas de exceljs", async () => {
    const bytes = await buildWorkbook({
      listings: {
        rows: [
          syntheticRow({
            precio: { formula: "2900*2", result: 5800 },
            link_video: { text: "https://example.cl/video", hyperlink: "https://example.cl/video" },
            destacados: {
              richText: [{ text: "Muy " }, { font: { bold: true }, text: "luminoso" }],
            },
            gastos_comunes_clp: { error: "#N/A" },
            disponibilidad: new Date(Date.UTC(2026, 10, 15)),
          }),
        ],
      },
    });
    const raw = (await readListingsWorkbook(bytes)).rows[0]?.raw ?? {};
    expect(raw).toMatchObject({
      precio: 5800,
      link_video: "https://example.cl/video",
      destacados: "Muy luminoso",
      gastos_comunes_clp: "#N/A",
    });
    expect(raw.disponibilidad).toEqual(new Date(Date.UTC(2026, 10, 15)));
    // El error de Excel no se pierde en silencio: el validador lo marca.
    const result = validator.validate(raw);
    expect(result.ok ? [] : result.errors.map((error) => [error.column, error.code])).toEqual([
      ["gastos_comunes_clp", "FIELD_NUMBER_INVALID"],
    ]);
  });

  it("salta las filas vacías y conserva el número real de fila", async () => {
    const bytes = await buildWorkbook({
      listings: { rows: [syntheticRow(), null, syntheticRow({ id_propiedad: "P002" })] },
    });
    const rows = (await readListingsWorkbook(bytes)).rows;
    expect(rows.map((row) => row.rowNumber)).toEqual([2, 4]);
  });

  it("con encabezados repetidos vale la primera columna, y headers los trae todos", async () => {
    const headers = [...TEMPLATE_COLUMNS, "precio"];
    const row = { ...syntheticRow(), precio: 5800 };
    const bytes = await buildWorkbook({ listings: { headers, rows: [row] } });
    const workbook = await readListingsWorkbook(bytes);
    expect(validator.checkHeaders(workbook.headers).duplicated).toEqual(["precio"]);
    expect(workbook.rows[0]?.raw.precio).toBe(5800);
  });
});

describe("readListingsWorkbook · hoja Corredor", () => {
  it("ausente → broker null", async () => {
    const bytes = await buildWorkbook({ listings: { rows: [syntheticRow()] }, broker: "missing" });
    expect((await readListingsWorkbook(bytes)).broker).toBeNull();
  });

  it("con los campos pero sin valores → broker null", async () => {
    const bytes = await buildWorkbook({
      broker: BROKER.map(([label]) => [label, null] as const),
    });
    expect((await readListingsWorkbook(bytes)).broker).toBeNull();
  });

  it("sin la columna Tu valor → IMPORT_FILE_INVALID", async () => {
    const bytes = await buildWorkbook({ broker: BROKER, brokerHeaders: ["Campo", "Valor"] });
    await expectError(readListingsWorkbook(bytes), "IMPORT_FILE_INVALID");
  });
});

describe("readListingsWorkbook · archivos inválidos", () => {
  it("archivo inexistente → IMPORT_FILE_NOT_FOUND", async () => {
    await expectError(
      readListingsWorkbook(join(tmpdir(), "no-existe-agentsales.xlsx")),
      "IMPORT_FILE_NOT_FOUND",
    );
  });

  it("una carpeta o un archivo que no es xlsx → IMPORT_FILE_INVALID", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentsales-xlsx-"));
    try {
      await expectError(readListingsWorkbook(dir), "IMPORT_FILE_INVALID");
      const notXlsx = join(dir, "propiedades.xlsx");
      await writeFile(notXlsx, "esto no es un Excel");
      await expectError(readListingsWorkbook(notXlsx), "IMPORT_FILE_INVALID");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sin hoja Propiedades → IMPORT_FILE_INVALID con las hojas encontradas", async () => {
    const bytes = await buildWorkbook({ listings: "missing", broker: BROKER });
    const error = await expectError(readListingsWorkbook(bytes), "IMPORT_FILE_INVALID");
    expect(isAppError(error) && error.details).toMatchObject({ sheets: ["Corredor"] });
  });

  it("más de 10 MB → IMPORT_FILE_INVALID sin intentar leerlo", async () => {
    await expectError(
      readListingsWorkbook(new Uint8Array(MAX_XLSX_BYTES + 1)),
      "IMPORT_FILE_INVALID",
    );
  });

  it(`más de ${MAX_DATA_ROWS} filas de datos → IMPORT_FILE_INVALID`, async () => {
    const rows = Array.from({ length: MAX_DATA_ROWS + 1 }, (_, index) => ({
      id_propiedad: `P${index}`,
    }));
    const bytes = await buildWorkbook({ listings: { headers: ["id_propiedad"], rows } });
    await expectError(readListingsWorkbook(bytes), "IMPORT_FILE_INVALID");
  });
});
