import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  AppError,
  foldText,
  isAppError,
  type ListingSheetInput,
  type ListingSheetRow,
  type RawBrokerSheet,
} from "@agentsales/core";
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

/**
 * Error del archivo. El mensaje y los `details` llevan solo el **nombre** del archivo, nunca la
 * ruta: terminan en `import_runs.error` y en la API. La causa original va en `cause`, que no se
 * expone.
 */
function fileError(
  code: "IMPORT_FILE_NOT_FOUND" | "IMPORT_FILE_INVALID",
  message: string,
  details: Record<string, unknown> = {},
  cause?: unknown,
): AppError {
  return new AppError(code, message, { details, ...(cause === undefined ? {} : { cause }) });
}

const invalidFile = (message: string, details?: Record<string, unknown>, cause?: unknown) =>
  fileError("IMPORT_FILE_INVALID", message, details, cause);

const tooBig = (bytes: number, file?: string) =>
  invalidFile(`El Excel pesa más de ${MAX_XLSX_BYTES / 1024 / 1024} MB`, {
    ...(file === undefined ? {} : { file }),
    bytes,
    maxBytes: MAX_XLSX_BYTES,
  });

const isBlankCell = (value: unknown) =>
  value === null || value === undefined || (typeof value === "string" && !value.trim());

/**
 * Valor de la celda aplanado. Las celdas combinadas que no son la principal se leen vacías:
 * exceljs les repite el valor de la principal, y eso copiaría un dato a otra columna.
 */
function cellValue(cell: ExcelJS.Cell): unknown {
  return cell.type === ExcelJS.ValueType.Merge ? null : flattenCell(cell.value);
}

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
  const file = basename(source);
  try {
    const info = await stat(source);
    if (!info.isFile()) throw invalidFile(`${file} no es un archivo`, { file });
    if (info.size > MAX_XLSX_BYTES) throw tooBig(info.size, file);
    return await readFile(source);
  } catch (error) {
    if (isAppError(error)) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw fileError("IMPORT_FILE_NOT_FOUND", `No existe el archivo ${file}`, { file }, error);
    }
    throw invalidFile(`No se pudo leer el archivo ${file}`, { file }, error);
  }
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
    throw invalidFile("El archivo no es un Excel (.xlsx) válido", {}, error);
  }
  return workbook;
}

/**
 * Objeto con solo propiedades propias, conservando la primera aparición de cada clave. Con `{}` y
 * `in`, un encabezado como `constructor` o `__proto__` se perdería por el prototipo.
 */
function firstWins(entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
  const seen = new Set<string>();
  return Object.fromEntries(
    entries.filter(([key]) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}

function readListingsSheet(sheet: ExcelJS.Worksheet): Pick<ListingSheetInput, "headers" | "rows"> {
  const columns: { index: number; header: string }[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, index) => {
    const header = cell.type === ExcelJS.ValueType.Merge ? "" : cellText(cell.value);
    if (header) columns.push({ index, header });
  });
  if (columns.length === 0) {
    throw invalidFile(`La hoja ${LISTINGS_SHEET} no tiene encabezados en la fila 1`, {
      sheet: sheet.name,
    });
  }

  const rows: ListingSheetRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const entries = columns.map(
      ({ index, header }) => [header, cellValue(row.getCell(index))] as const,
    );
    // La plantilla trae filas vacías con formato y listas desplegables: no son datos.
    if (entries.every(([, value]) => isBlankCell(value))) return;
    if (rows.length >= MAX_DATA_ROWS) {
      throw invalidFile(`La hoja ${LISTINGS_SHEET} tiene más de ${MAX_DATA_ROWS} filas`, {
        maxRows: MAX_DATA_ROWS,
      });
    }
    // Con encabezados repetidos vale la primera columna (`checkHeaders` los informa).
    rows.push({ rowNumber, raw: firstWins(entries) });
  });

  return { headers: columns.map((column) => column.header), rows };
}

function readBrokerSheet(sheet: ExcelJS.Worksheet): RawBrokerSheet | null {
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

  const entries: (readonly [string, unknown])[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1 || labelColumn === undefined || valueColumn === undefined) return;
    const label = cellText(row.getCell(labelColumn).value);
    if (label) entries.push([label, cellValue(row.getCell(valueColumn))]);
  });
  return entries.some(([, value]) => !isBlankCell(value)) ? firstWins(entries) : null;
}

/**
 * Lee un Excel con el formato de `data/plantillas/plantilla_propiedades.xlsx` (spec F1 §4.2):
 * - hoja **Propiedades**: encabezados en la fila 1 y una propiedad por fila;
 * - hoja **Corredor** (opcional): vertical, con las columnas `Campo` y `Tu valor`.
 *
 * No valida ni filtra: eso es del validador (F1-T02) y de `importListings` (F1-T04). Lanza
 * `IMPORT_FILE_NOT_FOUND` o `IMPORT_FILE_INVALID` (no es xlsx, excede los topes o falta la hoja).
 */
export async function readListingsWorkbook(
  source: string | Uint8Array,
): Promise<ListingSheetInput> {
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
