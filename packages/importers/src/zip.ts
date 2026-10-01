import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { AppError, isAppError } from "@agentsales/core";
import yauzl from "yauzl";

/** Topes del spec F1 §4.3. */
export const MAX_ZIP_ENTRIES = 2000;
export const MAX_ZIP_BYTES = 4 * 1024 ** 3;

export type ExtractZipOptions = {
  maxEntries?: number;
  /** Suma de los tamaños descomprimidos. */
  maxTotalBytes?: number;
};

export type ExtractZipResult = {
  /** Archivos escritos (sin carpetas ni entradas omitidas). */
  files: number;
  bytes: number;
};

/** Tipos de archivo de Unix guardados en `externalFileAttributes` (los 16 bits altos). */
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/** Errores del sistema que delatan un zip con entradas repetidas o en conflicto (`a` y `a/b`). */
const ZIP_CONFLICT_CODES = new Set(["EEXIST", "ENOTDIR", "EISDIR"]);

/** Basura de macOS y archivos ocultos: no se escriben. */
const isIgnoredPath = (name: string) =>
  name.split("/").some((segment) => segment.startsWith(".") || segment === "__MACOSX");

const invalidZip = (
  file: string,
  message: string,
  extra: Record<string, unknown> = {},
  cause?: unknown,
) =>
  new AppError("IMPORT_FILE_INVALID", message, {
    details: { file, ...extra },
    ...(cause === undefined ? {} : { cause }),
  });

/** Ruta de destino dentro de `root`, o `null` si se sale (zip-slip). */
function targetPath(root: string, name: string): string | null {
  const target = resolve(root, name);
  const rel = relative(root, target);
  return !rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : target;
}

/** El disco no deja escribir (lleno, permisos): no es culpa del zip. */
function extractFailed(file: string, error: unknown): AppError {
  const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
  return new AppError("IMPORT_EXTRACT_FAILED", `No se pudo descomprimir ${file} en el disco`, {
    details: { file, ...(code ? { errno: code } : {}) },
    cause: error,
  });
}

/**
 * Traduce un error al extraer. Los de yauzl (zip corrupto, nombre con `..` o absoluto, tamaño
 * real distinto del declarado) son del zip; los del sistema al escribir (disco lleno, permisos)
 * son `IMPORT_EXTRACT_FAILED`. Los mensajes llevan el nombre del zip, nunca la ruta.
 */
function toZipError(file: string, error: unknown): AppError {
  if (isAppError(error)) return error;
  const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
  const syscall = error instanceof Error && "syscall" in error;
  if (code && ZIP_CONFLICT_CODES.has(code)) {
    return invalidZip(file, `El zip ${file} tiene entradas repetidas o en conflicto`, {}, error);
  }
  if (syscall) return extractFailed(file, error);
  return invalidZip(file, `El zip ${file} no es válido o está dañado`, {}, error);
}

/**
 * Descomprime `zipPath` en `destDir` (que se crea si no existe), entrada por entrada y en
 * streaming. Si falla, deja en `destDir` lo que alcanzó a escribir: lo borra quien llama (el job,
 * en su `finally`; spec F1 §4.3).
 *
 * - **Topes:** cantidad de entradas (del directorio central, antes de escribir nada) y bytes
 *   descomprimidos (la suma de lo declarado, antes de escribir cada entrada). yauzl corta si una
 *   entrada trae más bytes de los que declara (`validateEntrySizes`), así que no hay zip bomb.
 * - **Zip-slip:** yauzl rechaza nombres absolutos o con `..`, y además se verifica que el destino
 *   quede dentro de `destDir`. Un zip con una entrada así se rechaza completo.
 * - **Se omiten:** enlaces simbólicos y otras entradas especiales, `__MACOSX/` y los ocultos.
 * - **Errores:** `IMPORT_FILE_NOT_FOUND`, `IMPORT_FILE_INVALID` (corrupto, cifrado, tope superado,
 *   ruta hostil) e `IMPORT_EXTRACT_FAILED` (el disco). Ninguno es reintentable.
 */
export async function extractZip(
  zipPath: string,
  destDir: string,
  options: ExtractZipOptions = {},
): Promise<ExtractZipResult> {
  const file = basename(zipPath);
  const maxEntries = options.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_ZIP_BYTES;

  let zipfile: yauzl.ZipFile;
  try {
    zipfile = await yauzl.openPromise(zipPath, { lazyEntries: true, validateEntrySizes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new AppError("IMPORT_FILE_NOT_FOUND", `No existe el archivo ${file}`, {
        details: { file },
        cause: error,
      });
    }
    throw toZipError(file, error);
  }

  if (zipfile.entryCount > maxEntries) {
    zipfile.close();
    throw invalidZip(file, `El zip ${file} tiene más de ${maxEntries} entradas`, {
      entries: zipfile.entryCount,
      maxEntries,
    });
  }

  const root = resolve(destDir);
  const result: ExtractZipResult = { files: 0, bytes: 0 };

  async function extractEntry(entry: yauzl.Entry): Promise<void> {
    const name = entry.fileName;
    if (isIgnoredPath(name)) return;

    const target = targetPath(root, name);
    if (!target)
      throw invalidZip(file, `El zip ${file} tiene una ruta no permitida`, { entry: name });

    const type = (entry.externalFileAttributes >>> 16) & S_IFMT;
    if (name.endsWith("/") || type === S_IFDIR) {
      await mkdir(target, { recursive: true });
      return;
    }
    // Sin tipo (zips de Windows) es un archivo; un enlace u otra cosa no se escribe.
    if (type !== 0 && type !== S_IFREG) return;
    if (entry.isEncrypted()) throw invalidZip(file, `El zip ${file} tiene archivos con contraseña`);

    if (result.bytes + entry.uncompressedSize > maxTotalBytes) {
      throw invalidZip(file, `El zip ${file} descomprimido pasa de ${maxTotalBytes} bytes`, {
        maxTotalBytes,
      });
    }
    result.bytes += entry.uncompressedSize;

    await mkdir(dirname(target), { recursive: true });
    const stream = await zipfile.openReadStreamPromise(entry);
    // `wx`: no pisa un archivo existente (entradas repetidas) ni escribe a través de un enlace.
    await pipeline(stream, createWriteStream(target, { flags: "wx" }));
    result.files += 1;
  }

  try {
    await mkdir(root, { recursive: true });
  } catch (error) {
    zipfile.close();
    throw extractFailed(file, error);
  }

  try {
    await new Promise<void>((done, fail) => {
      let failed = false;
      const abort = (error: unknown) => {
        if (failed) return;
        failed = true;
        fail(error);
      };
      zipfile.on("error", abort);
      zipfile.on("end", () => {
        if (!failed) done();
      });
      zipfile.on("entry", (entry: yauzl.Entry) => {
        extractEntry(entry).then(() => {
          if (!failed) zipfile.readEntry();
        }, abort);
      });
      zipfile.readEntry();
    });
  } catch (error) {
    throw toZipError(file, error);
  } finally {
    zipfile.close();
  }
  return result;
}
