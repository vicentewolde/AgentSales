import type { ListingCategory, ListingSource, ListingStatus } from "../enums.js";
import type { Listing, ListingFilters } from "../listing.js";
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
 * y del operador. `ListingImportRecord` es una proyección para la carga; la entidad completa es
 * `listingSchema` (`list`/`get`, para la API). Errores (`AppError`):
 * - `create` de un `(broker_id, external_ref)` que ya existe → `LISTING_CONFLICT`, **reintentable**
 *   (intentos del job solapados; el reintento lo reclasifica como `skipped` o `updated`);
 * - `update` de un id que no existe → `LISTING_NOT_FOUND`;
 * - fallo de conexión → `DB_UNAVAILABLE`, reintentable.
 * Los ids son uuid: la API los valida antes de llegar aquí.
 */
export interface ListingRepository {
  findByExternalRefs(
    brokerId: string,
    externalRefs: readonly string[],
  ): Promise<ListingImportRecord[]>;
  create(listing: NewListing): Promise<ListingImportRecord>;
  update(id: string, data: ListingImportData): Promise<ListingImportRecord>;
  /**
   * Pasa el aviso de `draft` a `ready` (ingesta de medios, F1-T07) y devuelve si cambió. Desde
   * cualquier otro estado no hace nada: no pisa `paused`, `archived`, `active` ni `closed`, y un
   * id que no existe también devuelve `false`.
   */
  promoteToReady(id: string): Promise<boolean>;
  /** Avisos con los filtros dados (exactos), del más reciente al más antiguo (`updated_at`). */
  list(filters?: ListingFilters): Promise<Listing[]>;
  /** `null` si no existe. */
  get(id: string): Promise<Listing | null>;
  /**
   * Cambio de estado **condicional**: solo si el aviso sigue en `from`. Devuelve si cambió
   * (`false` si otro cambio llegó antes, o si no existe). Lo usan el cambio manual
   * (`changeListingStatus`, que aplica sus reglas) y el sistema al publicar o retirar en `live`
   * (`ready` ↔ `active`, spec F3 §4.3).
   */
  changeStatus(id: string, from: ListingStatus, to: ListingStatus): Promise<boolean>;
}
