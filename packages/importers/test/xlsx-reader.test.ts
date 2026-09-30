import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildListingValidator, isAppError } from "@agentsales/core";
import { REAL_ESTATE_FIELD_DEFINITIONS, TEMPLATE_COLUMNS } from "@agentsales/db";
import ExcelJS from "exceljs";
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

  // Simulación (no un export real de Sheets): hojas renombradas y en otro orden, números y fechas
  // como texto, casillas como booleanos nativos y filas vacías al final.
  it("simulación de Google Sheets: otro nombre y orden de hojas, texto, booleanos y filas vacías", async () => {
    const asText = syntheticRow({
      precio: "5.800",
      sup_util_m2: "72,5",
      dormitorios: "3",
      gastos_comunes_clp: "$120.000",
      amoblado: false,
      mostrar_direccion_exacta: true,
      disponibilidad: "15-11-2026",
    });
    const bytes = await buildWorkbook({
      listings: { rows: [asText, null, null] },
      broker: BROKER,
      sheetNames: { listings: "PROPIEDADES", broker: "corredor ", brokerFirst: true },
    });
    const workbook = await readListingsWorkbook(bytes);
    expect(workbook.broker).not.toBeNull();
    expect(workbook.rows).toHaveLength(1);
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
            direccion: { error: "#REF!" },
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
      gastos_comunes_clp: { error: "#N/A" },
    });
    expect(raw.disponibilidad).toEqual(new Date(Date.UTC(2026, 10, 15)));
    // Los errores de Excel no pasan como texto válido: el validador los rechaza en cualquier campo.
    const result = validator.validate(raw);
    expect(
      result.ok ? [] : result.errors.map((error) => [error.column, error.code]).sort(),
    ).toEqual([
      ["direccion", "FIELD_VALUE_INVALID"],
      ["gastos_comunes_clp", "FIELD_VALUE_INVALID"],
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

describe("readListingsWorkbook · casos borde de exceljs", () => {
  it("encabezados y etiquetas como constructor, toString o __proto__ no se pierden", async () => {
    const headers = ["id_propiedad", "constructor", "toString", "__proto__"];
    const row = Object.fromEntries([
      ["id_propiedad", "P001"],
      ["constructor", "a"],
      ["toString", "b"],
      ["__proto__", "c"],
    ]);
    const bytes = await buildWorkbook({
      listings: { headers, rows: [row] },
      broker: [
        ["constructor", "x"],
        ["nombre_marca", "Marca"],
      ],
    });
    const workbook = await readListingsWorkbook(bytes);
    expect(Object.entries(workbook.rows[0]?.raw ?? {})).toEqual([
      ["id_propiedad", "P001"],
      ["constructor", "a"],
      ["toString", "b"],
      ["__proto__", "c"],
    ]);
    expect(Object.hasOwn(workbook.broker ?? {}, "constructor")).toBe(true);
  });

  it("las celdas combinadas que no son la principal se leen vacías (no copian el dato)", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Propiedades");
    sheet.addRow(["id_propiedad", "dormitorios", "banos"]);
    sheet.addRow(["P001", 3, null]);
    sheet.mergeCells("B2:C2");
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
    const raw = (await readListingsWorkbook(bytes)).rows[0]?.raw;
    expect(raw).toEqual({ id_propiedad: "P001", dormitorios: 3, banos: null });
  });

  it("encabezados que no son texto (número o fórmula) se leen como texto", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Propiedades");
    sheet.addRow(["id_propiedad", 2024, { formula: '"pre"&"cio"', result: "precio" }]);
    sheet.addRow(["P001", "x", 5800]);
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
    const result = await readListingsWorkbook(bytes);
    expect(result.headers).toEqual(["id_propiedad", "2024", "precio"]);
    expect(result.rows[0]?.raw).toEqual({ id_propiedad: "P001", "2024": "x", precio: 5800 });
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
    const error = await expectError(readListingsWorkbook(bytes), "IMPORT_FILE_INVALID");
    expect(isAppError(error) && error.message).toContain("Tu valor");
  });
});

describe("readListingsWorkbook · archivos inválidos", () => {
  it("archivo inexistente → IMPORT_FILE_NOT_FOUND, con el nombre y sin la ruta", async () => {
    const path = join(tmpdir(), "agentsales-ruta-privada", "no-existe.xlsx");
    const error = await expectError(readListingsWorkbook(path), "IMPORT_FILE_NOT_FOUND");
    expect(isAppError(error) && error.message).toBe("No existe el archivo no-existe.xlsx");
    expect(isAppError(error) && error.details).toEqual({ file: "no-existe.xlsx" });
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

  it("más de 10 MB en bytes → IMPORT_FILE_INVALID sin intentar leerlo", async () => {
    const error = await expectError(
      readListingsWorkbook(new Uint8Array(MAX_XLSX_BYTES + 1)),
      "IMPORT_FILE_INVALID",
    );
    expect(isAppError(error) && error.details).toEqual({
      bytes: MAX_XLSX_BYTES + 1,
      maxBytes: MAX_XLSX_BYTES,
    });
  });

  it("más de 10 MB en disco → IMPORT_FILE_INVALID sin leerlo (solo mira el tamaño)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentsales-xlsx-"));
    try {
      const big = join(dir, "grande.xlsx");
      await writeFile(big, "");
      await truncate(big, MAX_XLSX_BYTES + 1);
      const error = await expectError(readListingsWorkbook(big), "IMPORT_FILE_INVALID");
      expect(isAppError(error) && error.details).toEqual({
        file: "grande.xlsx",
        bytes: MAX_XLSX_BYTES + 1,
        maxBytes: MAX_XLSX_BYTES,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it(`exactamente ${MAX_DATA_ROWS} filas de datos se leen; las vacías con formato no cuentan`, async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Propiedades");
    sheet.addRow(["id_propiedad"]);
    for (let index = 0; index < MAX_DATA_ROWS; index++) sheet.addRow([`P${index}`]);
    for (let index = 0; index < 5; index++) {
      sheet.addRow([]).getCell(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFFFF00" },
      };
    }
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
    expect((await readListingsWorkbook(bytes)).rows).toHaveLength(MAX_DATA_ROWS);
  });

  it(`más de ${MAX_DATA_ROWS} filas de datos → IMPORT_FILE_INVALID`, async () => {
    const rows = Array.from({ length: MAX_DATA_ROWS + 1 }, (_, index) => ({
      id_propiedad: `P${index}`,
    }));
    const bytes = await buildWorkbook({ listings: { headers: ["id_propiedad"], rows } });
    const error = await expectError(readListingsWorkbook(bytes), "IMPORT_FILE_INVALID");
    expect(isAppError(error) && error.details).toEqual({ maxRows: MAX_DATA_ROWS });
  });
});
