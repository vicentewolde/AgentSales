import type { RawListingRow } from "./listing-validator/index.js";

/**
 * Tope del xlsx: lo aplican el lector (`packages/importers`) y la API al recibir una subida
 * (spec F1 §4.4). Vive en core para que los dos usen el mismo valor.
 */
export const MAX_XLSX_BYTES = 10 * 1024 * 1024;

/** Hoja Corredor tal como la lee el lector: `Campo` → `Tu valor`. La valida `importListings`. */
export type RawBrokerSheet = Readonly<Record<string, unknown>>;

export type ListingSheetRow = {
  /** Número de fila en Excel (la 1 es el encabezado), para el reporte. */
  rowNumber: number;
  raw: RawListingRow;
};

/**
 * Lo que un lector de planillas (hoy `packages/importers`, xlsx) entrega a `importListings`
 * (F1-T04). Es el contrato entre el adaptador y core: el adaptador depende de él, no al revés.
 */
export type ListingSheetInput = {
  /** Encabezados no vacíos de la hoja, en orden y con sus repetidos (para `checkHeaders`). */
  headers: readonly string[];
  /** Todas las filas con algún valor, sin filtrar: `EJEMPLO` y `Borrador` los filtra el caso de uso. */
  rows: readonly ListingSheetRow[];
  /** `null` si la hoja Corredor no existe o no tiene valores. */
  broker: RawBrokerSheet | null;
};
