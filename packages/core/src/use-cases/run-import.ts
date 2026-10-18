import { isTerminalImportRun } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import {
  type ImportRun,
  isUploadImportInput,
  type UploadedMedia,
  type UploadImportRunInput,
} from "../import-run.js";
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
    /**
     * Baja la planilla de R2 a la carpeta temporal del intento y la lee (`xlsx-reader`, con el tope
     * descomprimido de spec F8 §4.4); sus errores son `IMPORT_FILE_*`, `IMPORT_XLSX_TOO_LARGE` o
     * `STORAGE_*` (un corte de R2 es reintentable).
     */
    readSheet: (request: {
      runId: string;
      input: UploadImportRunInput;
    }) => Promise<ListingSheetInput>;
    /**
     * Prepara los medios del intento: baja de R2 el zip (y lo extrae) o los archivos de la carpeta,
     * en un directorio propio del intento. Sin medios, `source` es `null`. Si falla, no deja nada a
     * medias (lo limpia antes de lanzar). `folders` son las carpetas que la carga va a pedir (las
     * de las filas guardadas y `_marca`): sirven para reconocer un zip o una carpeta que trae todo
     * dentro de una sola carpeta (macOS → Comprimir "medios").
     */
    openMedia: (request: {
      runId: string;
      media: UploadedMedia | null;
      folders: readonly string[];
    }) => Promise<OpenedMedia>;
    /**
     * Borra lo de la carga en R2 (`imports/{id}/`) y en el disco del worker, solo al llegar a un
     * estado terminal. No falla si no hay nada.
     */
    discardInput: (runId: string) => Promise<void>;
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

/** Una carga de antes de F8 (rutas locales): sus archivos ya no existen y nunca se reintenta. */
const legacyInput = () =>
  new AppError(
    "IMPORT_INPUT_LEGACY",
    "Esta carga es de una versión anterior (sus archivos ya no están): vuelve a importarla",
  );

/**
 * Un error que no es `AppError` (un bug, o algo sin envolver) se normaliza a `INTERNAL_ERROR`, no
 * reintentable y sin exponer su mensaje (puede traer rutas): el run queda en `failed` y el job se
 * cierra, en vez de gastar reintentos sobre un run ya terminado.
 */
function normalized(error: unknown): AppError {
  return isAppError(error)
    ? error
    : new AppError("INTERNAL_ERROR", "Error interno al importar", { cause: error });
}

const runErrorOf = (error: AppError): ImportRunError => ({
  code: error.code,
  message: error.message,
});

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
 *    `succeeded`; los medios se liberan siempre, y sus archivos (en R2 y en el disco del worker)
 *    se borran al terminar. Una carga de antes de F8 se cierra con `IMPORT_INPUT_LEGACY`;
 * 3. con un error no reintentable, o en el último intento, deja el run en `failed` con `error`
 *    **antes** de relanzar. Un error reintentable en un intento que no es el último se relanza
 *    sin tocar el run: el job reintenta.
 *
 * Si el proceso muere, o la base no responde justo en el último intento, el run puede quedar en
 * `running`: el worker los cierra al arrancar (`ImportRunRepository.failAbandoned`).
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
  if (isTerminalImportRun(run.status)) return { outcome: "skipped", status: run.status };
  if (!(await deps.importRuns.markRunning(run.id))) {
    const current = await deps.importRuns.get(run.id);
    return { outcome: "skipped", status: current?.status ?? run.status };
  }

  try {
    if (!isUploadImportInput(run.input)) throw legacyInput();
    const input = await deps.readSheet({ runId: run.id, input: run.input });
    const imported = await importListings(deps, { runId: run.id, input });
    const media = await deps.openMedia({
      runId: run.id,
      media: run.input.media,
      folders: mediaFoldersOf(imported),
    });
    try {
      await ingestMedia(deps, { runId: run.id, imported, source: media.source });
    } finally {
      await media.close();
    }
  } catch (caught) {
    const error = normalized(caught);
    if (!error.retriable || isLastAttempt) await fail(deps, run.id, error);
    throw error;
  }

  if (!(await deps.importRuns.markSucceeded(run.id))) {
    // Otro intento ya lo dejó terminal (gana el primero): no se informa un éxito que no quedó.
    const current = await deps.importRuns.get(run.id);
    return { outcome: "skipped", status: current?.status ?? run.status };
  }
  await deps.discardInput(run.id).catch(() => undefined);
  return { outcome: "succeeded" };
}

/**
 * Deja el run en `failed` y borra sus archivos. Si la base no responde, se lanza ese error (que es
 * reintentable: si quedan intentos, el próximo deja el run en `failed`) con el error original
 * como `cause`, para que el motivo real no se pierda.
 */
async function fail(deps: RunImportDeps, runId: string, error: AppError): Promise<void> {
  try {
    await deps.importRuns.markFailed(runId, runErrorOf(error));
  } catch (markError) {
    const failure = normalized(markError);
    throw new AppError(failure.code, failure.message, {
      retriable: failure.retriable,
      details: { importRunId: runId, originalCode: error.code },
      cause: error,
    });
  }
  await deps.discardInput(runId).catch(() => undefined);
}
