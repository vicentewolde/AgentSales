import { AppError, isAppError } from "../errors.js";
import { type ImportMediaCounts, type ImportReport, importReportSchema } from "../import-run.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { ImportRunRepository } from "../ports/import-run-repository.js";
import type { ListingRepository } from "../ports/listing-repository.js";
import type {
  MediaFile,
  MediaFileSource,
  MediaFolderListing,
  MediaSkipReason,
} from "../ports/media-file-source.js";
import type { MediaArrangement, MediaRecord, MediaRepository } from "../ports/media-repository.js";
import type { MediaStorage } from "../ports/media-storage.js";
import type { ImportedRow, ImportListingsResult } from "./import-listings.js";

export type IngestMediaDeps = {
  media: MediaRepository;
  storage: MediaStorage;
  listings: ListingRepository;
  brokers: BrokerRepository;
  importRuns: ImportRunRepository;
};

export type IngestMediaParams = {
  /** El mismo run de `importListings`: de él sale `dry_run`. */
  runId: string;
  /** Lo que devolvió `importListings` para ese run. */
  imported: ImportListingsResult;
  /**
   * Los medios de la carga (la carpeta de `--media` o el zip extraído); `null` si no se pasaron.
   * Sin medios, igual cuentan las fotos que el aviso ya tenía para pasar a `ready`.
   */
  source: MediaFileSource | null;
};

export type IngestMediaResult = {
  media: ImportMediaCounts;
  report: ImportReport;
};

/** Carpeta del logo dentro de la raíz de medios (spec F1 §4.3). */
export const BRAND_FOLDER = "_marca";

const SKIP_REASON_TEXT: Readonly<Record<MediaSkipReason, string>> = {
  unsupported_type: "tipo de archivo no admitido (jpg, png, webp, heic, mp4 o mov)",
  signature_mismatch: "el contenido no corresponde a la extensión",
  empty: "archivo vacío",
  too_large: "video demasiado grande",
  not_a_file: "no es un archivo (subcarpeta o enlace)",
  unreadable: "no se pudo leer",
};

/**
 * Problemas de **un** archivo, que no se arreglan reintentando el job: el archivo se borró o
 * cambió entre el listado y la subida. Quedan como advertencia y la carga sigue (spec F1 §4.2).
 * Todo lo demás (R2 o Neon caídos, credenciales, conflictos) se propaga.
 */
const FILE_PROBLEM_CODES = new Set(["MEDIA_FILE_UNREADABLE", "STORAGE_CONTENT_MISMATCH"]);

const isFileProblem = (error: unknown): error is AppError =>
  isAppError(error) && FILE_PROBLEM_CODES.has(error.code);

/** Errores de `MediaFileSource.list`: la carpeta de una fila, no la carga completa. */
const isFolderProblem = (error: unknown): error is AppError =>
  isAppError(error) && error.code.startsWith("MEDIA_FOLDER_");

/** Nombre del archivo dentro de su carpeta. */
const fileName = (relPath: string) => relPath.slice(relPath.lastIndexOf("/") + 1);

const sameName = (relPath: string, name: string) =>
  fileName(relPath).toLowerCase() === name.trim().toLowerCase();

/** Clave del original en R2 (spec F1 §4.3): determinística, así reintentar sobrescribe lo mismo. */
export const listingMediaPath = (brokerId: string, listingId: string, file: MediaFile) =>
  `brokers/${brokerId}/listings/${listingId}/original/${file.sha256}.${file.extension}`;

export const brandMediaPath = (brokerId: string, file: MediaFile) =>
  `brokers/${brokerId}/brand/${file.sha256}.${file.extension}`;

const emptyCounts = (): ImportMediaCounts => ({
  filesUploaded: 0,
  filesExisting: 0,
  filesSkipped: 0,
  filesFailed: 0,
});

/**
 * Lista una carpeta. Un problema de la carpeta se vuelve advertencia y devuelve `null`: no se
 * sabe qué hay en ella, así que quien llama no debe tratarla como vacía.
 */
async function listFolder(
  source: MediaFileSource,
  folder: string,
  warnings: string[],
): Promise<MediaFolderListing | null> {
  try {
    return await source.list(folder);
  } catch (error) {
    if (!isFolderProblem(error)) throw error;
    warnings.push(error.message);
    return null;
  }
}

/**
 * Sube un archivo. Devuelve el error si es un problema del archivo (advertencia) y lanza
 * cualquier otro. El reintento es del job, que vuelve a abrir el archivo: la deduplicación por
 * sha256 evita volver a subir lo que ya terminó.
 */
async function upload(
  storage: MediaStorage,
  path: string,
  file: MediaFile,
): Promise<AppError | null> {
  try {
    // Con el sha256, R2 rechaza un contenido distinto del que se listó (el archivo cambió).
    await storage.putStream(path, file.open(), {
      contentType: file.mime,
      contentLength: file.bytes,
      sha256: file.sha256,
    });
    return null;
  } catch (error) {
    if (isFileProblem(error)) return error;
    throw error;
  }
}

/**
 * Texto fijo por código: el mensaje del error puede traer la clave interna en R2, y las
 * advertencias las leen el operador, la CLI y el panel.
 */
const FAILURE_TEXT: Readonly<Record<string, string>> = {
  MEDIA_FILE_UNREADABLE: "no se pudo leer el archivo",
  STORAGE_CONTENT_MISMATCH: "el archivo cambió mientras se subía",
};

const failedWarning = (subject: string, error: AppError) =>
  `${subject}: no se pudo subir (${FAILURE_TEXT[error.code] ?? error.code})`;

/** Un medio de la carpeta tal como quedó en esta carga (o quedaría, en `dry_run`). */
type Placed = { file: MediaFile; record: MediaRecord | null };

type OrderItem = { kind: MediaRecord["kind"]; id: string | null };

/**
 * Orden y portada finales, con la carpeta ya listada (spec F1 §4.3): los archivos de la carpeta en
 * su orden natural y, después, los que el aviso ya tenía y ya no están (no se borran), en su orden
 * anterior. La portada es `foto_portada` si es una foto de la carpeta; si no, la primera foto de la
 * carpeta. Si la carpeta no trae fotos, se conserva la portada guardada (o, sin ella, la primera
 * foto anterior): `media` no guarda el nombre original, así que `foto_portada` solo se resuelve
 * contra la carpeta.
 */
function arrange(
  placed: readonly Placed[],
  absent: readonly MediaRecord[],
  coverFile: string | null,
  warnings: string[],
): { order: OrderItem[]; coverIndex: number } {
  const order: OrderItem[] = [
    ...placed.map(({ file, record }) => ({ kind: file.kind, id: record?.id ?? null })),
    ...absent.map((record) => ({ kind: record.kind, id: record.id })),
  ];
  const firstFolderPhoto = placed.findIndex(({ file }) => file.kind === "image");
  let fallbackIndex = firstFolderPhoto;
  let fallbackText = `se usa ${fileName(placed[firstFolderPhoto]?.file.relPath ?? "")}`;
  if (firstFolderPhoto < 0) {
    const keptCover = absent.findIndex((record) => record.isCover && record.kind === "image");
    const oldPhoto =
      keptCover >= 0 ? keptCover : absent.findIndex((record) => record.kind === "image");
    fallbackIndex = oldPhoto >= 0 ? placed.length + oldPhoto : -1;
    fallbackText = oldPhoto >= 0 ? "se conserva la portada anterior" : "y el aviso no tiene fotos";
  }
  if (coverFile === null) return { order, coverIndex: fallbackIndex };

  const chosen = placed.findIndex(({ file }) => sameName(file.relPath, coverFile));
  if (chosen < 0) {
    warnings.push(
      `foto_portada «${coverFile}» no está entre los medios de la carpeta; ${fallbackText}`,
    );
    return { order, coverIndex: fallbackIndex };
  }
  if (order[chosen]?.kind !== "image") {
    warnings.push(`foto_portada «${coverFile}» no es una foto; ${fallbackText}`);
    return { order, coverIndex: fallbackIndex };
  }
  return { order, coverIndex: chosen };
}

/** Fija orden y portada solo si algo cambió respecto de lo guardado. */
async function saveArrangement(
  deps: IngestMediaDeps,
  listingId: string,
  known: readonly MediaRecord[],
  order: readonly { id: string | null }[],
  coverIndex: number,
) {
  const byId = new Map(known.map((record) => [record.id, record]));
  const items: MediaArrangement[] = [];
  order.forEach(({ id }, index) => {
    if (id !== null) items.push({ id, sortOrder: index, isCover: index === coverIndex });
  });
  const changed = items.some((item) => {
    const before = byId.get(item.id);
    return before?.sortOrder !== item.sortOrder || before.isCover !== item.isCover;
  });
  if (changed) await deps.media.arrange(listingId, items);
}

type RowContext = {
  deps: IngestMediaDeps;
  source: MediaFileSource | null;
  dryRun: boolean;
  brokerId: string | null;
  counts: ImportMediaCounts;
};

const NO_PHOTOS_WARNING =
  "Sin fotos: el aviso queda en borrador (hace falta al menos una para «Listo»)";

/** Pasa a `ready` si corresponde, o advierte si el aviso queda en borrador por falta de fotos. */
async function settleStatus(
  ctx: RowContext,
  row: ImportedRow,
  loadStatus: NonNullable<ImportedRow["control"]>["loadStatus"],
  hasPhoto: boolean,
  warnings: string[],
) {
  if (loadStatus !== "ready") return;
  if (hasPhoto) {
    if (!ctx.dryRun && row.listingId !== null)
      await ctx.deps.listings.promoteToReady(row.listingId);
    return;
  }
  // Solo si queda en borrador por esto (un `paused` no se toca). Un aviso nuevo en `dry_run` no
  // tiene estado todavía, pero nacería en `draft`.
  if ((row.status ?? "draft") === "draft") warnings.push(NO_PHOTOS_WARNING);
}

/** Medios de una fila: subir, deduplicar, ordenar, elegir portada y decidir `ready`. */
async function ingestRow(ctx: RowContext, row: ImportedRow, warnings: string[]): Promise<void> {
  const { deps, counts } = ctx;
  const control = row.control;
  if (control === null || row.externalRef === null) return;

  const listingId = row.listingId;
  // Fuera de `dry_run`, `importListings` siempre deja el aviso y el corredor guardados: si no,
  // contar archivos como subidos sin subirlos mentiría en el reporte.
  if (!ctx.dryRun && (listingId === null || ctx.brokerId === null)) {
    throw new AppError("MEDIA_INGEST_STATE_INVALID", "Fila guardada sin aviso o sin corredor", {
      details: { rowNumber: row.rowNumber },
    });
  }
  const current = listingId === null ? [] : await deps.media.listOriginals(listingId);
  const byChecksum = new Map(current.map((record) => [record.checksum, record]));

  const folder = control.mediaFolder ?? row.externalRef;
  const listing = ctx.source === null ? null : await listFolder(ctx.source, folder, warnings);
  if (listing === null) {
    // Sin carpeta legible no se sabe qué hay: se conservan orden y portada, y cuentan las fotos
    // que el aviso ya tenía.
    const hasPhoto = current.some((record) => record.kind === "image");
    await settleStatus(ctx, row, control.loadStatus, hasPhoto, warnings);
    return;
  }

  for (const { relPath, reason } of listing.skipped) {
    warnings.push(`${relPath}: ${SKIP_REASON_TEXT[reason]}`);
    counts.filesSkipped += 1;
  }

  const placed: Placed[] = [];
  const seen = new Map<string, string>();
  for (const file of listing.files) {
    const twin = seen.get(file.sha256);
    if (twin !== undefined) {
      warnings.push(`${file.relPath}: es el mismo archivo que ${twin}`);
      counts.filesSkipped += 1;
      continue;
    }
    seen.set(file.sha256, file.relPath);

    const existing = byChecksum.get(file.sha256);
    if (existing !== undefined) {
      counts.filesExisting += 1;
      placed.push({ file, record: existing });
      continue;
    }
    if (ctx.dryRun || listingId === null || ctx.brokerId === null) {
      counts.filesUploaded += 1;
      placed.push({ file, record: null });
      continue;
    }

    // Primero R2 y después la fila: si falla entre medio, el reintento sobrescribe la misma clave.
    const storagePath = listingMediaPath(ctx.brokerId, listingId, file);
    const problem = await upload(deps.storage, storagePath, file);
    if (problem !== null) {
      warnings.push(failedWarning(file.relPath, problem));
      counts.filesFailed += 1;
      continue;
    }
    const record = await deps.media.create({
      listingId,
      brokerId: ctx.brokerId,
      kind: file.kind,
      storagePath,
      mime: file.mime,
      bytes: file.bytes,
      checksum: file.sha256,
      sortOrder: placed.length,
      isCover: false,
    });
    counts.filesUploaded += 1;
    placed.push({ file, record });
  }

  const present = new Set(placed.map(({ record }) => record?.id));
  const absent = current.filter((record) => !present.has(record.id));
  const { order, coverIndex } = arrange(placed, absent, control.coverFile, warnings);

  if (!ctx.dryRun && listingId !== null) {
    const created = placed.flatMap(({ record }) => (record === null ? [] : [record]));
    await saveArrangement(deps, listingId, [...current, ...created], order, coverIndex);
  }
  const hasPhoto = order.some((item) => item.kind === "image");
  await settleStatus(ctx, row, control.loadStatus, hasPhoto, warnings);
}

/** Logo del corredor (`_marca/<logo>`); sus advertencias van a `broker.warnings`. */
async function ingestLogo(ctx: RowContext, logoFile: string, warnings: string[]): Promise<void> {
  const { deps } = ctx;
  if (ctx.source === null) {
    warnings.push(`logo «${logoFile}»: no se indicó una carpeta de medios`);
    return;
  }
  const listing = await listFolder(ctx.source, BRAND_FOLDER, warnings);
  if (listing === null) return;
  const file = listing.files.find((candidate) => sameName(candidate.relPath, logoFile));
  if (file === undefined) {
    const skipped = listing.skipped.find((candidate) => sameName(candidate.relPath, logoFile));
    warnings.push(
      skipped === undefined
        ? `logo «${logoFile}»: no está en ${BRAND_FOLDER}/`
        : `logo «${logoFile}»: ${SKIP_REASON_TEXT[skipped.reason]}`,
    );
    return;
  }
  if (file.kind !== "image") {
    warnings.push(`logo «${logoFile}»: no es una imagen`);
    return;
  }
  if (ctx.dryRun || ctx.brokerId === null) return;

  const storagePath = brandMediaPath(ctx.brokerId, file);
  let record = await deps.media.findByStoragePath(storagePath);
  if (record === null) {
    const problem = await upload(deps.storage, storagePath, file);
    if (problem !== null) {
      warnings.push(failedWarning(`logo «${logoFile}»`, problem));
      return;
    }
    record = await deps.media.create({
      listingId: null,
      brokerId: ctx.brokerId,
      kind: file.kind,
      storagePath,
      mime: file.mime,
      bytes: file.bytes,
      checksum: file.sha256,
      sortOrder: 0,
      isCover: false,
    });
  }
  await deps.brokers.setLogo(ctx.brokerId, record.id);
}

/**
 * Ingesta de medios de una carga (spec F1 §4.3), después de `importListings` y en el mismo run:
 * 1. el logo del corredor, si la hoja Corredor lo indica;
 * 2. por cada fila guardada (`created`, `updated` y también `skipped`, así agregar fotos sin tocar
 *    el Excel las sube): lista su carpeta, deduplica por sha256 contra lo que el aviso ya tiene,
 *    sube a R2 y después registra en `media`, ordena, elige la portada y pasa a `ready` si
 *    `estado_carga = Listo` y tiene al menos una foto (`promoteToReady`: solo desde `draft`);
 * 3. guarda el reporte con `media` y las advertencias.
 *
 * Un problema de una carpeta o de un archivo es una advertencia de su fila. Un error reintentable
 * (`STORAGE_UNAVAILABLE`, `DB_UNAVAILABLE`, `MEDIA_CONFLICT`) se propaga para que el job reintente;
 * reintentar no duplica nada. En `dry_run` solo lee: arma el reporte de lo que se subiría.
 */
export async function ingestMedia(
  deps: IngestMediaDeps,
  { runId, imported, source }: IngestMediaParams,
): Promise<IngestMediaResult> {
  const run = await deps.importRuns.get(runId);
  if (run === null) {
    throw new AppError("IMPORT_RUN_NOT_FOUND", `No existe la carga ${runId}`, {
      details: { runId },
    });
  }

  const counts = emptyCounts();
  const ctx: RowContext = { deps, source, dryRun: run.dryRun, brokerId: imported.brokerId, counts };
  // Copia (zod arma objetos nuevos): el resultado de `importListings` no se modifica.
  const report: ImportReport = importReportSchema.parse(imported.report);

  if (imported.logoFile !== null && report.broker !== null) {
    await ingestLogo(ctx, imported.logoFile, report.broker.warnings);
  }

  const reportRows = new Map(report.rows.map((reportRow) => [reportRow.rowNumber, reportRow]));
  for (const row of imported.rows) {
    if (row.outcome === "failed" || row.outcome === "ignored") continue;
    const reportRow = reportRows.get(row.rowNumber);
    await ingestRow(ctx, row, reportRow?.warnings ?? []);
  }

  report.media = counts;
  await deps.importRuns.recordMediaResult(runId, report);
  return { media: counts, report };
}
