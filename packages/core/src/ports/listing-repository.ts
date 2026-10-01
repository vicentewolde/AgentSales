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
 * y del operador. `ListingImportRecord` es una proyección para la carga, sin esquema; la entidad
 * completa (`listingSchema`) y `list`/`get` llegan con la API (F1-T10), y la ingesta de medios
 * (F1-T07) suma `promoteToReady(id)` (solo desde `draft`). Errores (`AppError`):
 * - `create` de un `(broker_id, external_ref)` que ya existe → `LISTING_CONFLICT`, **reintentable**
 *   (intentos del job solapados; el reintento lo reclasifica como `skipped` o `updated`);
 * - `update` de un id que no existe → `LISTING_NOT_FOUND`;
 * - fallo de conexión → `DB_UNAVAILABLE`, reintentable.
 */
export interface ListingRepository {
  findByExternalRefs(
    brokerId: string,
    externalRefs: readonly string[],
  ): Promise<ListingImportRecord[]>;
  create(listing: NewListing): Promise<ListingImportRecord>;
  update(id: string, data: ListingImportData): Promise<ListingImportRecord>;
}
