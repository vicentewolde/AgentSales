import { isTerminalImportRun } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import {
  type ImportRun,
  isUploadImportInput,
  type UploadedMedia,
  type UploadImportRunInput,
} from "../import-run.js";
import { MAX_XLSX_BYTES } from "../listing-sheet.js";
import type { ImportRunError, ImportRunRepository } from "../ports/import-run-repository.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { MediaStorage, SignedUpload } from "../ports/media-storage.js";

// Subidas directas a R2 (spec F8 §4.4, ADR-0025): el panel y la CLI piden la carga con los nombres
// y tamaños, suben cada archivo con su URL prefirmada y después la empiezan. Ningún archivo pasa
// por la API.

/** Topes y tiempos de las subidas (spec F8 §4.4). */
export const IMPORT_UPLOAD = {
  /** El zip de medios, como el tope descomprimido de F1; también la suma de una carpeta. */
  maxZipBytes: 4 * 1024 ** 3,
  maxFolderFiles: 500,
  /** Los archivos de una carpeta de hasta esto llevan su sha256 (el navegador lo calcula en memoria). */
  sha256UpToBytes: 100 * 1024 * 1024,
  /** Vida de las URLs de subida. */
  urlTtlSeconds: 60 * 60,
  /** Una carga que sigue esperando sus archivos después de esto se cierra (`IMPORT_UPLOAD_ABANDONED`). */
  abandonedAfterMs: 24 * 60 * 60 * 1000,
  maxNameBytes: 255,
  maxPathBytes: 1024,
} as const;

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const ZIP_MIME = "application/zip";
/** Los archivos de una carpeta: el worker los reconoce por su firma, no por el tipo declarado. */
export const MEDIA_FILE_MIME = "application/octet-stream";

/** El motivo de una carga cerrada porque nadie terminó de subirla. */
export const IMPORT_UPLOAD_ABANDONED: ImportRunError = {
  code: "IMPORT_UPLOAD_ABANDONED",
  message: "Nadie terminó de subir los archivos de esta carga en 24 horas: vuelve a importarla",
};

/** Las claves de R2 de una carga viven bajo este prefijo, y se borran juntas. */
export const importObjectsPrefix = (runId: string) => `imports/${runId}/`;

export type ImportUploadFile = { name: string; size: number; sha256?: string | undefined };

export type ImportUploadMediaRequest =
  | { kind: "zip"; name: string; size: number }
  | {
      kind: "folder";
      name: string;
      files: readonly { path: string; size: number; sha256?: string | undefined }[];
    };

export type RequestImportUploadParams = {
  /** El corredor pedido (slug) o el del usuario corredor; `null` si sale de la hoja Corredor. */
  broker: string | null;
  /** El corredor de una carga de un usuario corredor (spec F7 §4.4); `null` si es del administrador. */
  brokerId: string | null;
  dryRun: boolean;
  xlsx: { name: string; size: number; sha256: string };
  media: ImportUploadMediaRequest | null;
};

export type RequestImportUploadDeps = {
  importRuns: Pick<ImportRunRepository, "create">;
  storage: Pick<MediaStorage, "signedUploadUrl">;
  /** uuid de la carga: se necesita antes de crearla, para las claves de R2. */
  newId: () => string;
  /** `MAX_IMPORT_UPLOAD_MB` en bytes: el tope de cada archivo (el zip, además, 4 GB). */
  maxFileBytes: number;
};

/** Una URL de subida: `kind` dice qué archivo es (la planilla, el zip o uno de la carpeta). */
export type ImportUploadTarget = SignedUpload & {
  kind: "xlsx" | "zip" | "file";
  /** El nombre de la planilla o del zip, o la ruta relativa del archivo de la carpeta. */
  name: string;
};

/** Bytes de un texto en UTF-8 (los topes de nombres de los discos son en bytes). */
function byteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: justamente se buscan caracteres de control.
const CONTROL = /[\u0000-\u001f\u007f]/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = (message: string, details: Record<string, unknown> = {}) =>
  new AppError("IMPORT_UPLOAD_INVALID", message, { details });

const tooLarge = (message: string, details: Record<string, unknown>) =>
  new AppError("IMPORT_UPLOAD_TOO_LARGE", message, { details });

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/** Un nombre de archivo sin carpetas: nada de `/`, `\`, control, `.` ni `..`, y hasta 255 bytes. */
function checkFileName(name: string, what: string): string {
  const trimmed = name.trim();
  if (
    trimmed === "" ||
    trimmed === "." ||
    trimmed === ".." ||
    /[\\/]/.test(trimmed) ||
    CONTROL.test(trimmed) ||
    byteLength(trimmed) > IMPORT_UPLOAD.maxNameBytes
  ) {
    throw invalid(`${what} no tiene un nombre válido`, { name: name.slice(0, 100) });
  }
  return trimmed;
}

/**
 * Una ruta relativa de un archivo de la carpeta, con `/`: sin `..`, `.`, tramos vacíos, ruta
 * absoluta (`/x`, `C:…`), `\` ni caracteres de control (spec F8 §4.4). `null` si es válida; si no,
 * el motivo.
 */
export function relativePathIssue(path: string): string | null {
  if (path === "") return "vacía";
  if (CONTROL.test(path)) return "con caracteres de control";
  if (path.includes("\\")) return "con \\";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "absoluta";
  if (byteLength(path) > IMPORT_UPLOAD.maxPathBytes) return "demasiado larga";
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return "con un tramo no permitido";
    if (byteLength(segment) > IMPORT_UPLOAD.maxNameBytes) return "con un nombre demasiado largo";
  }
  return null;
}

function checkSize(size: number, what: string): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw invalid(`${what}: tamaño inválido`, { size });
  }
}

function checkSha256(sha256: string | undefined, what: string): string | undefined {
  if (sha256 === undefined) return undefined;
  const lower = sha256.toLowerCase();
  if (!SHA256_HEX.test(lower)) throw invalid(`${what}: sha256 inválido`);
  return lower;
}

/** Arma y valida la entrada de la carga (sin tocar nada). */
function uploadInput(
  runId: string,
  params: RequestImportUploadParams,
  maxFileBytes: number,
): UploadImportRunInput {
  const prefix = importObjectsPrefix(runId);
  const xlsxName = checkFileName(params.xlsx.name, "La planilla");
  if (!xlsxName.toLowerCase().endsWith(".xlsx")) {
    throw invalid("La planilla debe ser un Excel (.xlsx)", { name: xlsxName });
  }
  checkSize(params.xlsx.size, "La planilla");
  if (params.xlsx.size === 0) throw invalid("La planilla está vacía");
  if (params.xlsx.size > MAX_XLSX_BYTES) {
    throw tooLarge(`La planilla pasa de ${mb(MAX_XLSX_BYTES)}`, {
      size: params.xlsx.size,
      maxBytes: MAX_XLSX_BYTES,
    });
  }
  const xlsxSha = checkSha256(params.xlsx.sha256, "La planilla");
  if (xlsxSha === undefined) throw invalid("La planilla debe traer su sha256");

  return {
    broker: params.broker,
    dryRun: params.dryRun,
    xlsx: {
      key: `${prefix}xlsx/${xlsxName}`,
      name: xlsxName,
      size: params.xlsx.size,
      sha256: xlsxSha,
    },
    media: params.media === null ? null : uploadMedia(prefix, params.media, maxFileBytes),
  };
}

function uploadMedia(
  prefix: string,
  media: ImportUploadMediaRequest,
  maxFileBytes: number,
): UploadedMedia {
  const maxZip = Math.min(maxFileBytes, IMPORT_UPLOAD.maxZipBytes);
  if (media.kind === "zip") {
    const name = checkFileName(media.name, "El zip de medios");
    if (!name.toLowerCase().endsWith(".zip")) {
      throw invalid("Los medios deben ser un .zip o una carpeta", { name });
    }
    checkSize(media.size, "El zip de medios");
    if (media.size === 0) throw invalid("El zip de medios está vacío");
    if (media.size > maxZip) {
      throw tooLarge(`El zip de medios pasa de ${mb(maxZip)}`, {
        size: media.size,
        maxBytes: maxZip,
      });
    }
    return { kind: "zip", key: `${prefix}media.zip`, name, size: media.size };
  }

  const name = checkFileName(media.name, "La carpeta de medios");
  if (media.files.length === 0) throw invalid("La carpeta de medios está vacía");
  if (media.files.length > IMPORT_UPLOAD.maxFolderFiles) {
    throw invalid(`La carpeta de medios tiene más de ${IMPORT_UPLOAD.maxFolderFiles} archivos`, {
      files: media.files.length,
      maxFiles: IMPORT_UPLOAD.maxFolderFiles,
    });
  }
  const seen = new Set<string>();
  let total = 0;
  const files = media.files.map((file) => {
    const issue = relativePathIssue(file.path);
    if (issue !== null) {
      throw invalid(`Un archivo de la carpeta tiene una ruta no permitida (${issue})`, {
        path: file.path.slice(0, 200),
      });
    }
    // Como en el zip: en macOS `Foto.jpg` y `foto.jpg` son el mismo archivo.
    const key = file.path.toLowerCase();
    if (seen.has(key)) {
      throw invalid("La carpeta tiene archivos repetidos", { path: file.path.slice(0, 200) });
    }
    seen.add(key);
    checkSize(file.size, file.path);
    if (file.size > maxFileBytes) {
      throw tooLarge(`${file.path} pasa de ${mb(maxFileBytes)}`, {
        path: file.path.slice(0, 200),
        size: file.size,
        maxBytes: maxFileBytes,
      });
    }
    total += file.size;
    const sha256 = checkSha256(file.sha256, file.path);
    if (sha256 === undefined && file.size <= IMPORT_UPLOAD.sha256UpToBytes) {
      throw invalid(`${file.path} debe traer su sha256`, { path: file.path.slice(0, 200) });
    }
    return { path: file.path, size: file.size, ...(sha256 === undefined ? {} : { sha256 }) };
  });
  if (total > IMPORT_UPLOAD.maxZipBytes) {
    throw tooLarge(`La carpeta de medios pasa de ${mb(IMPORT_UPLOAD.maxZipBytes)}`, {
      size: total,
      maxBytes: IMPORT_UPLOAD.maxZipBytes,
    });
  }
  return { kind: "folder", prefix: `${prefix}media/`, name, files };
}

/** Cada archivo esperado en R2: su clave, cómo se muestra, su tamaño y su sha256 (si lo trae). */
export function expectedImportObjects(input: UploadImportRunInput): {
  kind: ImportUploadTarget["kind"];
  key: string;
  name: string;
  size: number;
  contentType: string;
  sha256?: string;
}[] {
  const objects: ReturnType<typeof expectedImportObjects> = [
    {
      kind: "xlsx",
      key: input.xlsx.key,
      name: input.xlsx.name,
      size: input.xlsx.size,
      contentType: XLSX_MIME,
      sha256: input.xlsx.sha256,
    },
  ];
  const { media } = input;
  if (media?.kind === "zip") {
    objects.push({
      kind: "zip",
      key: media.key,
      name: media.name,
      size: media.size,
      contentType: ZIP_MIME,
    });
  } else if (media?.kind === "folder") {
    for (const file of media.files) {
      objects.push({
        kind: "file",
        key: `${media.prefix}${file.path}`,
        name: file.path,
        size: file.size,
        contentType: MEDIA_FILE_MIME,
        ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }),
      });
    }
  }
  return objects;
}

/**
 * Pide una carga con subida directa (spec F8 §4.4): valida nombres, rutas, tamaños y topes, crea la
 * carga en `awaiting_upload` con su corredor y `dryRun`, y devuelve una URL prefirmada de `PUT`
 * por archivo (1 h, con su tamaño y, si lo trae, su sha256). Firmar no habla con R2.
 */
export async function requestImportUpload(
  deps: RequestImportUploadDeps,
  params: RequestImportUploadParams,
): Promise<{ run: ImportRun; uploads: ImportUploadTarget[] }> {
  const id = deps.newId();
  const input = uploadInput(id, params, deps.maxFileBytes);
  const objects = expectedImportObjects(input);
  // Se firma antes de crear la carga: si algo falla al firmar, no queda una carga huérfana.
  const uploads = await Promise.all(
    objects.map(async (object): Promise<ImportUploadTarget> => {
      const signed = await deps.storage.signedUploadUrl(object.key, {
        contentType: object.contentType,
        contentLength: object.size,
        ...(object.sha256 === undefined ? {} : { sha256: object.sha256 }),
        ttlSeconds: IMPORT_UPLOAD.urlTtlSeconds,
      });
      return { kind: object.kind, name: object.name, ...signed };
    }),
  );
  const run = await deps.importRuns.create({
    id,
    status: "awaiting_upload",
    source: "xlsx",
    fileName: input.xlsx.name,
    dryRun: params.dryRun,
    input,
    brokerId: params.brokerId,
  });
  return { run, uploads };
}

export type ImportObjectStorage = Pick<MediaStorage, "list" | "delete">;

/** Borra los objetos de R2 de una carga (`imports/<id>/`). Devuelve cuántos borró. */
export async function deleteImportObjects(
  storage: ImportObjectStorage,
  runId: string,
): Promise<number> {
  const objects = await storage.list(importObjectsPrefix(runId));
  for (const object of objects) await storage.delete(object.path);
  return objects.length;
}

export type StartImportDeps = {
  importRuns: Pick<ImportRunRepository, "get" | "markQueued" | "markFailed">;
  storage: ImportObjectStorage;
  queue: JobQueue;
};

/**
 * Empieza una carga ya subida (spec F8 §4.4): revisa en R2 que estén todos sus archivos con su
 * tamaño, la pasa a `queued` y encola `import.run` (`singletonKey = importRunId`).
 *
 * - Si falta alguno (o tiene otro tamaño): `IMPORT_UPLOAD_INCOMPLETE` con sus nombres, y la carga
 *   sigue esperando (el cliente sube lo que falta y vuelve a empezar).
 * - Empezar dos veces no encola dos veces: una carga que ya no espera sus archivos se devuelve tal
 *   cual (así un reintento de la CLI tras un corte no falla).
 * - Con la cola caída (`QUEUE_UNAVAILABLE`), la carga queda en `failed` con ese motivo y se borran
 *   sus archivos, como en F1; el error se propaga (503).
 */
export async function startImport(
  deps: StartImportDeps,
  { importRunId }: { importRunId: string },
): Promise<ImportRun> {
  const run = await deps.importRuns.get(importRunId);
  if (run === null) {
    throw new AppError("IMPORT_RUN_NOT_FOUND", `No existe la carga ${importRunId}`, {
      details: { importRunId },
    });
  }
  if (run.status !== "awaiting_upload") return run;
  if (!isUploadImportInput(run.input)) {
    throw new AppError("IMPORT_RUN_INVALID", `La carga ${run.id} no tiene archivos en R2`);
  }

  const listed = new Map(
    (await deps.storage.list(importObjectsPrefix(run.id))).map((object) => [
      object.path,
      object.size,
    ]),
  );
  const missing = expectedImportObjects(run.input).filter(
    (object) => listed.get(object.key) !== object.size,
  );
  if (missing.length > 0) {
    throw new AppError(
      "IMPORT_UPLOAD_INCOMPLETE",
      `Faltan ${missing.length} archivo(s) por subir: ${missing
        .slice(0, 5)
        .map((object) => object.name)
        .join(", ")}${missing.length > 5 ? "…" : ""}`,
      {
        details: {
          missing: missing.slice(0, 20).map((object) => object.name),
          count: missing.length,
        },
      },
    );
  }

  if (!(await deps.importRuns.markQueued(run.id))) {
    // Otro "empezar" llegó antes: se devuelve como quedó.
    return (await deps.importRuns.get(run.id)) ?? run;
  }
  try {
    await deps.queue.enqueue("import.run", { importRunId: run.id }, { singletonKey: run.id });
  } catch (error) {
    if (isAppError(error) && error.code === "QUEUE_UNAVAILABLE") {
      await deps.importRuns
        .markFailed(run.id, { code: error.code, message: error.message })
        .catch(() => false);
      await deleteImportObjects(deps.storage, run.id).catch(() => 0);
    }
    throw error;
  }
  return { ...run, status: "queued" };
}

export type CloseAbandonedImportsDeps = {
  importRuns: Pick<ImportRunRepository, "get" | "failAbandonedUploads">;
  storage: ImportObjectStorage;
  now?: () => Date;
};

export type CloseAbandonedImportsResult = {
  /** Cargas cerradas porque nadie terminó de subirlas. */
  abandoned: string[];
  /** Objetos borrados de R2 (de cargas cerradas, terminadas o que ya no existen). */
  deletedObjects: number;
  /** Cargas cuyos objetos no se pudieron revisar o borrar (quedan para la próxima vuelta). */
  failed: string[];
};

/**
 * La limpieza de las subidas (spec F8 §4.4, en `publications.watch`, cada hora):
 * 1. cierra como `failed` (`IMPORT_UPLOAD_ABANDONED`) las cargas que llevan más de 24 h esperando
 *    sus archivos;
 * 2. borra de R2 los objetos de las cargas cerradas o terminadas (el worker ya los borra al
 *    terminar; esto recoge lo que quedó si ese borrado falló) y los de cargas que no existen,
 *    pasadas las 24 h. Nunca toca los de una carga que espera, está en cola o procesando.
 * Un error con una carga la deja para la próxima vuelta y sigue con las demás.
 */
export async function closeAbandonedImports(
  deps: CloseAbandonedImportsDeps,
): Promise<CloseAbandonedImportsResult> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - IMPORT_UPLOAD.abandonedAfterMs);
  const abandoned = await deps.importRuns.failAbandonedUploads(cutoff, IMPORT_UPLOAD_ABANDONED);

  const byRun = new Map<string, { paths: string[]; newest: number }>();
  for (const object of await deps.storage.list("imports/")) {
    const runId = object.path.split("/")[1];
    if (runId === undefined || runId === "") continue;
    const entry = byRun.get(runId) ?? { paths: [], newest: 0 };
    entry.paths.push(object.path);
    entry.newest = Math.max(entry.newest, object.lastModified.getTime());
    byRun.set(runId, entry);
  }

  let deletedObjects = 0;
  const failed: string[] = [];
  for (const [runId, { paths, newest }] of byRun) {
    try {
      // Un tramo que no es uuid no es de una carga (y la base lo rechazaría).
      const run = UUID.test(runId) ? await deps.importRuns.get(runId) : null;
      const drop = run === null ? newest < cutoff.getTime() : isTerminalImportRun(run.status);
      if (!drop) continue;
      for (const path of paths) {
        await deps.storage.delete(path);
        deletedObjects += 1;
      }
    } catch {
      failed.push(runId);
    }
  }
  return { abandoned, deletedObjects, failed };
}
