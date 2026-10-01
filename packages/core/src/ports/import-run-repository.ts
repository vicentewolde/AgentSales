import type { ListingSource } from "../enums.js";
import type { ImportCounts, ImportReport, ImportRun, ImportRunInput } from "../import-run.js";

export type NewImportRun = {
  source: ListingSource;
  fileName: string;
  dryRun: boolean;
  input: ImportRunInput;
};

/**
 * Cargas (`import_runs`). F1-T04 registra el resultado de las filas. Llegan después, como métodos
 * nuevos:
 * - los cambios de estado del run (`running`, `succeeded`, `failed`), con el job `import.run`
 *   (F1-T09). Son **condicionales** (`UPDATE … WHERE status IN (…)`, que devuelven si cambió),
 *   así un reintento sobre un run ya terminal no hace nada;
 * - `list`, para `GET /imports` (F1-T11).
 * Los ids son uuid: la API los valida antes de llegar aquí.
 */
export interface ImportRunRepository {
  create(run: NewImportRun): Promise<ImportRun>;
  get(id: string): Promise<ImportRun | null>;
  /**
   * Guarda el corredor, los contadores y el reporte de `importListings` (también en `dry_run`).
   * No cambia `status` ni `finished_at`. Un id inexistente es `IMPORT_RUN_NOT_FOUND`.
   */
  recordListingsResult(
    id: string,
    result: { brokerId: string | null; counts: ImportCounts; report: ImportReport },
  ): Promise<void>;
  /**
   * Reemplaza el reporte con el de `ingestMedia` (el mismo, más `media` y las advertencias de
   * medios). No toca contadores, `status` ni `finished_at`. Un id inexistente es
   * `IMPORT_RUN_NOT_FOUND`.
   */
  recordMediaResult(id: string, report: ImportReport): Promise<void>;
}
