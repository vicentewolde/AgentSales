import type { ListingCategory, ListingSource, ListingStatus } from "../enums.js";
import type { ListingAttributes, ListingCoreFields } from "../listing-validator/index.js";

/** Lo que la importación necesita saber de un aviso ya guardado. */
export type ListingImportRecord = {
  id: string;
  externalRef: string;
  status: ListingStatus;
  sourceHash: string;
};

/** Datos de un aviso que escribe la importación (columnas fijas, atributos y origen). */
export type ListingImportData = ListingCoreFields & {
  attributes: ListingAttributes;
  sourceHash: string;
};

export type NewListing = ListingImportData & {
  brokerId: string;
  category: ListingCategory;
  source: ListingSource;
};

/**
 * Avisos (`listings`), únicos por `(broker_id, external_ref)`. Un aviso nuevo nace en `draft`, y
 * la importación nunca cambia `status` (ni lo pisa al reimportar): eso es de la ingesta de medios
 * y del operador. Los errores de conexión son `AppError("DB_UNAVAILABLE", { retriable: true })`.
 */
export interface ListingRepository {
  findByExternalRefs(
    brokerId: string,
    externalRefs: readonly string[],
  ): Promise<ListingImportRecord[]>;
  create(listing: NewListing): Promise<ListingImportRecord>;
  update(id: string, data: ListingImportData): Promise<ListingImportRecord>;
}
