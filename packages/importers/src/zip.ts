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
  /** Entradas omitidas: ocultas, `__MACOSX/`, enlaces simbólicos y otras especiales. */
  skipped: number;
};

/** Tipos de archivo de Unix guardados en `externalFileAttributes` (los 16 bits altos). */
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? String(error.code) : undefined;

/**
 * Basura de macOS y archivos ocultos: no se escriben. `.` y `..` no son ocultos: algunas
 * herramientas escriben todos los nombres como `./carpeta/foto.jpg`.
 */
const isIgnoredPath = (name: string) =>
  name
    .split("/")
    .some(
      (segment) =>
        (segment.startsWith(".") && segment !== "." && segment !== "..") || segment === "__MACOSX",
    );

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

/**
 * Ruta de destino de una entrada dentro de `root`, o `null` si se sale (zip-slip). Devuelve `root`
 * para una entrada que apunta a la raíz misma (`./`). yauzl ya rechaza los nombres absolutos o con
 * `..`; esto es la segunda barrera, por si cambia la validación de yauzl o se desactiva.
 */
export function entryTargetPath(root: string, name: string): string | null {
  const target = resolve(root, name);
  const rel = relative(root, target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : target;
}

/** El disco no deja escribir (lleno, permisos): no es culpa del zip. */
function extractFailed(file: string, error: unknown): AppError {
  const code = errorCode(error);
  return new AppError("IMPORT_EXTRACT_FAILED", `No se pudo descomprimir ${file} en el disco`, {
    details: { file, ...(code ? { errno: code } : {}) },
    cause: error,
  });
}

/**
 * Traduce un error al extraer. Los de yauzl (zip corrupto, nombre con `..` o absoluto, tamaño
 * real distinto del declarado) son del zip, igual que un nombre demasiado largo. Los demás del
 * sistema al escribir (disco lleno, permisos, un `destDir` que ya tenía esos archivos) son
 * `IMPORT_EXTRACT_FAILED`: los conflictos del propio zip se detectan antes de escribir. Los
 * mensajes llevan el nombre del zip, nunca la ruta.
 */
function toZipError(file: string, error: unknown): AppError {
  if (isAppError(error)) return error;
  if (errorCode(error) === "ENAMETOOLONG") {
    return invalidZip(file, `El zip ${file} tiene nombres de archivo demasiado largos`, {}, error);
  }
  if (error instanceof Error && "syscall" in error) return extractFailed(file, error);
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
 *   quede dentro de `destDir` (`entryTargetPath`). Un zip con una entrada así se rechaza completo.
 * - **Se omiten** (y se cuentan en `skipped`): enlaces simbólicos y otras entradas especiales,
 *   `__MACOSX/` y los ocultos.
 * - **Nombres repetidos o en conflicto** (un archivo `p` y otro `p/foto.jpg`), también si solo
 *   cambian mayúsculas (`Foto.jpg` y `foto.jpg`, que en macOS son el mismo archivo):
 *   `IMPORT_FILE_INVALID`, igual en todos los sistemas. Se detectan antes de escribir.
 * - **Errores:** `IMPORT_FILE_NOT_FOUND`, `IMPORT_FILE_INVALID` (no es zip, corrupto, cifrado,
 *   tope superado, ruta hostil, nombres repetidos o en conflicto) e `IMPORT_EXTRACT_FAILED` (el
 *   disco, o un `destDir` que ya tenía esos archivos). Ninguno es reintentable.
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
    if (errorCode(error) === "ENOENT") {
      throw new AppError("IMPORT_FILE_NOT_FOUND", `No existe el archivo ${file}`, {
        details: { file },
        cause: error,
      });
    }
    // Al abrir, cualquier error (una carpeta, sin permiso, no es zip) es del archivo de entrada.
    throw invalidZip(file, `No se pudo abrir ${file} como zip`, {}, error);
  }

  if (zipfile.entryCount > maxEntries) {
    zipfile.close();
    throw invalidZip(file, `El zip ${file} tiene más de ${maxEntries} entradas`, {
      entries: zipfile.entryCount,
      maxEntries,
    });
  }

  const root = resolve(destDir);
  const result: ExtractZipResult = { files: 0, bytes: 0, skipped: 0 };
  // Rutas de esta extracción, sin mayúsculas, para detectar nombres repetidos o en conflicto.
  const filePaths = new Set<string>();
  const dirPaths = new Set<string>();
  const keyOf = (path: string) => path.toLowerCase();

  /** Registra `dir` y sus carpetas padre; falla si alguna ya es un archivo del zip. */
  function claimDirs(dir: string, name: string) {
    for (let current = dir; current !== root; current = dirname(current)) {
      const key = keyOf(current);
      if (filePaths.has(key)) {
        throw invalidZip(file, `El zip ${file} tiene entradas en conflicto`, { entry: name });
      }
      if (dirPaths.has(key)) break;
      dirPaths.add(key);
    }
  }

  async function extractEntry(entry: yauzl.Entry): Promise<void> {
    const name = entry.fileName;
    // La ruta se verifica antes que cualquier otra cosa, incluso para lo que se va a omitir.
    const target = entryTargetPath(root, name);
    if (!target) {
      throw invalidZip(file, `El zip ${file} tiene una ruta no permitida`, { entry: name });
    }

    const type = (entry.externalFileAttributes >>> 16) & S_IFMT;
    const isDir = name.endsWith("/") || type === S_IFDIR;
    // Sin tipo (zips de Windows) es un archivo; un enlace u otra cosa no se escribe.
    if (isIgnoredPath(name) || (!isDir && type !== 0 && type !== S_IFREG)) {
      result.skipped += 1;
      return;
    }
    if (isDir) {
      claimDirs(target, name);
      await mkdir(target, { recursive: true });
      return;
    }
    if (target === root) {
      throw invalidZip(file, `El zip ${file} tiene una ruta no permitida`, { entry: name });
    }
    if (entry.isEncrypted()) throw invalidZip(file, `El zip ${file} tiene archivos con contraseña`);
    const key = keyOf(target);
    if (filePaths.has(key)) {
      throw invalidZip(file, `El zip ${file} tiene archivos repetidos`, { entry: name });
    }
    if (dirPaths.has(key)) {
      throw invalidZip(file, `El zip ${file} tiene entradas en conflicto`, { entry: name });
    }
    claimDirs(dirname(target), name);

    if (result.bytes + entry.uncompressedSize > maxTotalBytes) {
      throw invalidZip(file, `El zip ${file} descomprimido pasa de ${maxTotalBytes} bytes`, {
        maxTotalBytes,
      });
    }
    result.bytes += entry.uncompressedSize;

    await mkdir(dirname(target), { recursive: true });
    const stream = await zipfile.openReadStreamPromise(entry);
    filePaths.add(key);
    // `wx`: no pisa un archivo que ya estaba en `destDir` ni escribe a través de un enlace. Un
    // error acá no es del zip (sus conflictos ya se detectaron): `IMPORT_EXTRACT_FAILED`.
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
        extractEntry(entry)
          .then(() => {
            if (!failed) zipfile.readEntry();
          })
          .catch(abort);
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
