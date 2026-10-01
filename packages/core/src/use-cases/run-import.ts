import { AppError, isAppError } from "../errors.js";
import type { ImportRun, ImportRunInput } from "../import-run.js";
import type { ListingSheetInput } from "../listing-sheet.js";
import type { ImportRunError } from "../ports/import-run-repository.js";
import type { MediaFileSource } from "../ports/media-file-source.js";
import {
  type ImportListingsDeps,
  type ImportListingsResult,
  importListings,
} from "./import-listings.js";
import { BRAND_FOLDER, type IngestMediaDeps, ingestMedia } from "./ingest-media.js";

/** Los medios de un intento: la fuente y cómo liberarla (borrar el zip extraído). */
export type OpenedMedia = {
  source: MediaFileSource | null;
  /** No falla: se llama siempre al terminar el intento, también si falló. */
  close(): Promise<void>;
};

export type RunImportDeps = ImportListingsDeps &
  IngestMediaDeps & {
    /** Lee el xlsx del run (`xlsx-reader`); sus errores son `IMPORT_FILE_*`. */
    readSheet: (input: ImportRunInput) => Promise<ListingSheetInput>;
    /**
     * Prepara los medios del run: la carpeta, o el zip extraído en `tmp/imports/{id}/extracted/`,
     * que se recrea en cada intento. Sin `mediaDir`, `source` es `null`. Si falla, no deja nada
     * a medias (lo limpia antes de lanzar). `folders` son las carpetas que la carga va a pedir
     * (las de las filas guardadas y `_marca`): sirven para reconocer un zip que trae todo dentro
     * de una sola carpeta (macOS → Comprimir "medios").
     */
    openMedia: (run: ImportRun, folders: readonly string[]) => Promise<OpenedMedia>;
    /** Borra el staging del run (`tmp/imports/{id}/`), solo al llegar a un estado terminal. */
    discardStaging: (runId: string) => Promise<void>;
  };

export type RunImportParams = {
  importRunId: string;
  /** Último intento del job (`retryCount >= retryLimit`): un error deja el run en `failed`. */
  isLastAttempt: boolean;
};

export type RunImportResult =
  | { outcome: "succeeded" }
  /** El run ya estaba terminado (otro intento llegó antes): no se hizo nada. */
  | { outcome: "skipped"; status: ImportRun["status"] };

/** Motivo para `import_runs.error`. Un error que no es `AppError` no expone su mensaje. */
function runErrorOf(error: unknown): ImportRunError {
  return isAppError(error)
    ? { code: error.code, message: error.message }
    : { code: "INTERNAL_ERROR", message: "Error interno al importar" };
}

const isTerminal = (status: ImportRun["status"]) => status === "succeeded" || status === "failed";

/** Carpetas que `ingestMedia` va a listar: las de las filas guardadas y la del logo. */
function mediaFoldersOf(imported: ImportListingsResult): string[] {
  const folders = new Set<string>();
  for (const row of imported.rows) {
    if (row.control !== null && row.externalRef !== null) {
      folders.add(row.control.mediaFolder ?? row.externalRef);
    }
  }
  if (imported.logoFile !== null) folders.add(BRAND_FOLDER);
  return [...folders];
}

/**
 * Corre una carga (el handler del job `import.run`, spec F1 §4.6):
 * 1. si el run ya terminó, no hace nada (esa guarda evita que dos intentos se pisen);
 * 2. lo pasa a `running`, lee el xlsx, corre `importListings` y luego `ingestMedia`, y lo deja en
 *    `succeeded`; los medios se liberan siempre, y el staging se borra al terminar;
 * 3. con un error no reintentable, o en el último intento, deja el run en `failed` con `error`
 *    **antes** de relanzar, así ningún run queda en `running` para siempre. Un error reintentable
 *    en un intento que no es el último se relanza sin tocar el run: el job reintenta.
 *
 * Reintentar es seguro: `importListings` escribe por `external_ref` e `ingestMedia` deduplica
 * por sha256, así que lo ya hecho sale `skipped` o `existing`.
 */
export async function runImport(
  deps: RunImportDeps,
  { importRunId, isLastAttempt }: RunImportParams,
): Promise<RunImportResult> {
  const run = await deps.importRuns.get(importRunId);
  if (run === null) {
    throw new AppError("IMPORT_RUN_NOT_FOUND", `No existe la carga ${importRunId}`, {
      details: { importRunId },
    });
  }
  if (isTerminal(run.status)) return { outcome: "skipped", status: run.status };
  if (!(await deps.importRuns.markRunning(run.id))) {
    const current = await deps.importRuns.get(run.id);
    return { outcome: "skipped", status: current?.status ?? run.status };
  }

  try {
    const input = await deps.readSheet(run.input);
    const imported = await importListings(deps, { runId: run.id, input });
    const media = await deps.openMedia(run, mediaFoldersOf(imported));
    try {
      await ingestMedia(deps, { runId: run.id, imported, source: media.source });
    } finally {
      await media.close();
    }
    await deps.importRuns.markSucceeded(run.id);
  } catch (error) {
    const retriable = isAppError(error) && error.retriable;
    if (!retriable || isLastAttempt) {
      // Si esto falla (la base no responde), se propaga ese error, que es reintentable: el próximo
      // intento vuelve a correr y deja el run en `failed`. Así no queda en `running`.
      await deps.importRuns.markFailed(run.id, runErrorOf(error));
      await deps.discardStaging(run.id).catch(() => undefined);
    }
    throw error;
  }
  await deps.discardStaging(run.id).catch(() => undefined);
  return { outcome: "succeeded" };
}
