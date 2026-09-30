import { readFile, stat } from "node:fs/promises";
import { AppError, foldText, type RawListingRow } from "@agentsales/core";
import ExcelJS from "exceljs";
import { cellText, flattenCell } from "./cells.js";

/** Mismo tope que la API para el xlsx (spec F1 §4.4). */
export const MAX_XLSX_BYTES = 10 * 1024 * 1024;
/** Filas de datos por archivo; el piloto son unas pocas propiedades. */
export const MAX_DATA_ROWS = 1000;

const LISTINGS_SHEET = "Propiedades";
const BROKER_SHEET = "Corredor";
const BROKER_LABEL_HEADER = "Campo";
const BROKER_VALUE_HEADER = "Tu valor";

export type WorkbookRow = {
  /** Número de fila en Excel (la 1 es el encabezado), para el reporte. */
  rowNumber: number;
  /** Encabezado → celda aplanada. Con encabezados repetidos, vale el primero. */
  raw: RawListingRow;
};

export type ListingsWorkbook = {
  /** Encabezados no vacíos de la hoja Propiedades, en orden y tal como están escritos. */
  headers: string[];
  /** Todas las filas con algún valor; `EJEMPLO` y `Borrador` los filtra `importListings`. */
  rows: WorkbookRow[];
  /** Hoja Corredor: `Campo` → `Tu valor`. `null` si la hoja no existe o no tiene valores. */
  broker: RawListingRow | null;
};

function invalidFile(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError("IMPORT_FILE_INVALID", message, { details });
}

const isBlankCell = (value: unknown) =>
  value === null || value === undefined || (typeof value === "string" && !value.trim());

/** Busca una hoja por nombre, sin mayúsculas, tildes ni espacios (Sheets puede cambiarlos). */
function findSheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet | undefined {
  const target = foldText(name);
  return workbook.worksheets.find((sheet) => foldText(sheet.name) === target);
}

async function loadBytes(source: string | Uint8Array): Promise<Uint8Array> {
  if (typeof source !== "string") {
    if (source.byteLength > MAX_XLSX_BYTES) throw tooBig(source.byteLength);
    return source;
  }
  try {
    const info = await stat(source);
    if (!info.isFile()) throw invalidFile("La ruta no es un archivo", { path: source });
    if (info.size > MAX_XLSX_BYTES) throw tooBig(info.size);
    return await readFile(source);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new AppError("IMPORT_FILE_NOT_FOUND", `No existe el archivo ${source}`, {
        details: { path: source },
      });
    }
    throw invalidFile("No se pudo leer el archivo", { path: source, cause: String(error) });
  }
}

function tooBig(bytes: number): AppError {
  return invalidFile(`El Excel pesa más de ${MAX_XLSX_BYTES / 1024 / 1024} MB`, { bytes });
}

async function loadWorkbook(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  try {
    // Los tipos de exceljs declaran su propio `Buffer` (un ArrayBuffer); `load` se lo pasa a JSZip,
    // que acepta un ArrayBuffer. Se copia solo el tramo del archivo.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    await workbook.xlsx.load(copy.buffer);
  } catch (error) {
    throw invalidFile("El archivo no es un Excel (.xlsx) válido", { cause: String(error) });
  }
  return workbook;
}

function readListingsSheet(sheet: ExcelJS.Worksheet): Pick<ListingsWorkbook, "headers" | "rows"> {
  const headerRow = sheet.getRow(1);
  const columns: { index: number; header: string }[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, index) => {
    const header = cellText(cell.value);
    if (header) columns.push({ index, header });
  });
  if (columns.length === 0) {
    throw invalidFile(`La hoja ${LISTINGS_SHEET} no tiene encabezados en la fila 1`, {
      sheet: sheet.name,
    });
  }

  const rows: WorkbookRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const raw: Record<string, unknown> = {};
    let hasValue = false;
    for (const { index, header } of columns) {
      const value = flattenCell(row.getCell(index).value);
      if (!isBlankCell(value)) hasValue = true;
      if (!(header in raw)) raw[header] = value;
    }
    // La plantilla trae filas vacías con formato y listas desplegables: no son datos.
    if (!hasValue) return;
    if (rows.length >= MAX_DATA_ROWS) {
      throw invalidFile(`La hoja ${LISTINGS_SHEET} tiene más de ${MAX_DATA_ROWS} filas`, {
        maxRows: MAX_DATA_ROWS,
      });
    }
    rows.push({ rowNumber, raw });
  });

  return { headers: columns.map((column) => column.header), rows };
}

function readBrokerSheet(sheet: ExcelJS.Worksheet): RawListingRow | null {
  let labelColumn: number | undefined;
  let valueColumn: number | undefined;
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, index) => {
    const header = foldText(cellText(cell.value));
    if (header === foldText(BROKER_LABEL_HEADER)) labelColumn = index;
    if (header === foldText(BROKER_VALUE_HEADER)) valueColumn = index;
  });
  if (labelColumn === undefined || valueColumn === undefined) {
    throw invalidFile(
      `La hoja ${BROKER_SHEET} debe tener las columnas ${BROKER_LABEL_HEADER} y ${BROKER_VALUE_HEADER}`,
      { sheet: sheet.name },
    );
  }

  const fields: Record<string, unknown> = {};
  let hasValue = false;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1 || labelColumn === undefined || valueColumn === undefined) return;
    const label = cellText(row.getCell(labelColumn).value);
    if (!label || label in fields) return;
    const value = flattenCell(row.getCell(valueColumn).value);
    if (!isBlankCell(value)) hasValue = true;
    fields[label] = value;
  });
  return hasValue ? fields : null;
}

/**
 * Lee un Excel con el formato de `data/plantillas/plantilla_propiedades.xlsx` (spec F1 §4.2):
 * - hoja **Propiedades**: encabezados en la fila 1 y una propiedad por fila;
 * - hoja **Corredor** (opcional): vertical, con las columnas `Campo` y `Tu valor`.
 *
 * No valida ni filtra: eso es del validador (F1-T02) y de `importListings` (F1-T04). Lanza
 * `IMPORT_FILE_NOT_FOUND` o `IMPORT_FILE_INVALID` (no es xlsx, excede los topes o falta la hoja).
 */
export async function readListingsWorkbook(source: string | Uint8Array): Promise<ListingsWorkbook> {
  const workbook = await loadWorkbook(await loadBytes(source));
  const listings = findSheet(workbook, LISTINGS_SHEET);
  if (listings === undefined) {
    throw invalidFile(`Falta la hoja ${LISTINGS_SHEET}`, {
      sheets: workbook.worksheets.map((sheet) => sheet.name),
    });
  }
  const brokerSheet = findSheet(workbook, BROKER_SHEET);
  return {
    ...readListingsSheet(listings),
    broker: brokerSheet === undefined ? null : readBrokerSheet(brokerSheet),
  };
}
