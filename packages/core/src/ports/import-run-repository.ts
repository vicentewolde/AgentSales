import type { AccessScope } from "../access.js";
import type { ListingSource } from "../enums.js";
import type { ImportCounts, ImportReport, ImportRun, ImportRunInput } from "../import-run.js";

export type NewImportRun = {
  /**
   * uuid generado por quien llama (opcional): la API lo necesita antes de crear el run, para
   * guardar los archivos en `tmp/imports/{id}/input/`. Sin él, lo genera la base.
   */
  id?: string;
  source: ListingSource;
  fileName: string;
  dryRun: boolean;
  input: ImportRunInput;
  /**
   * El corredor de una carga de un usuario corredor (spec F7 §4.4): nace con él (así la ve en cola)
   * y el job nunca la lleva a otro ni crea uno. Por defecto `null` (la del administrador, que lo
   * toma de la hoja Corredor).
   */
  brokerId?: string | null;
};

/** Motivo de una carga fallida (`import_runs.error`): sin rutas ni datos de clientes. */
export type ImportRunError = { code: string; message: string };

/**
 * Cargas (`import_runs`). F1-T04 registra el resultado de las filas, y F1-T09 los cambios de
 * estado: son **condicionales** (`UPDATE … WHERE status IN (…)`) y devuelven si cambió, así un
 * reintento sobre un run ya terminal no hace nada.
 * Los ids son uuid: la API los valida antes de llegar aquí.
 */
export interface ImportRunRepository {
  create(run: NewImportRun): Promise<ImportRun>;
  get(id: string): Promise<ImportRun | null>;
  /**
   * Las cargas más recientes primero (`created_at`), hasta `limit` (por defecto 50), dentro del
   * alcance: un corredor no ve las de `broker_id` nulo (spec F7 §4.4).
   */
  list(limit: number, scope: AccessScope): Promise<ImportRun[]>;
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
  /**
   * Cierra los runs abandonados: los que siguen en `running` con `started_at` anterior a
   * `startedBefore` pasan a `failed` con `error` (el proceso murió, o la base no respondió en el
   * último intento). No toca los `queued`: su job puede seguir en la cola si el worker estuvo
   * apagado. Devuelve los ids cerrados.
   */
  failAbandoned(startedBefore: Date, error: ImportRunError): Promise<string[]>;
}
