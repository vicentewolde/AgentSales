import type { ListingSource } from "../enums.js";
import type { ImportCounts, ImportReport, ImportRun } from "../import-run.js";

export type NewImportRun = {
  source: ListingSource;
  fileName: string;
  dryRun: boolean;
  /** Rutas absolutas de entrada y broker pedido; sin secretos (spec F1 §4.5). */
  input: Record<string, unknown>;
};

/**
 * Cargas (`import_runs`). F1-T04 registra el resultado de las filas; los cambios de estado del run
 * (`running`, `succeeded`, `failed`) los suma el job `import.run` (F1-T09).
 */
export interface ImportRunRepository {
  create(run: NewImportRun): Promise<ImportRun>;
  get(id: string): Promise<ImportRun | null>;
  /** Guarda el corredor, los contadores y el reporte de `importListings` (también en `dry_run`). */
  recordListingsResult(
    id: string,
    result: { brokerId: string | null; counts: ImportCounts; report: ImportReport },
  ): Promise<void>;
}
