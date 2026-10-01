import type { ListingSource } from "../enums.js";
import type { ImportCounts, ImportReport, ImportRun, ImportRunInput } from "../import-run.js";

export type NewImportRun = {
  source: ListingSource;
  fileName: string;
  dryRun: boolean;
  input: ImportRunInput;
};

/** Motivo de una carga fallida (`import_runs.error`): sin rutas ni datos de clientes. */
export type ImportRunError = { code: string; message: string };

/**
 * Cargas (`import_runs`). F1-T04 registra el resultado de las filas, y F1-T09 los cambios de
 * estado: son **condicionales** (`UPDATE … WHERE status IN (…)`) y devuelven si cambió, así un
 * reintento sobre un run ya terminal no hace nada. `list` llega con `GET /imports` (F1-T11).
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
  /**
   * `queued` o `running` → `running` (un reintento del job lo vuelve a tomar). Fija `started_at`
   * solo la primera vez. `false` si el run ya terminó o no existe.
   */
  markRunning(id: string): Promise<boolean>;
  /** `running` → `succeeded`, con `finished_at`. `false` desde otro estado o si no existe. */
  markSucceeded(id: string): Promise<boolean>;
  /**
   * `queued` o `running` → `failed`, con `error` y `finished_at`. `false` si ya terminó o no
   * existe: el primer estado terminal gana.
   */
  markFailed(id: string, error: ImportRunError): Promise<boolean>;
}
