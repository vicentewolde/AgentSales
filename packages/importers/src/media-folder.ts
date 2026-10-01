import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AppError,
  type MediaFile,
  type MediaFileSource,
  type MediaFolderListing,
  type SkippedMediaFile,
} from "@agentsales/core";
import { mediaTypeOf, SIGNATURE_BYTES } from "./media-types.js";

export type MediaFolderSourceOptions = {
  /** Tope de un video (`MAX_VIDEO_MB` en bytes). Uno más grande se omite sin calcular su hash. */
  maxVideoBytes: number;
};

/** No sigue un enlace simbólico puesto entre el listado y la lectura (en Windows no existe). */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** Basura de los sistemas operativos: se ignora sin advertencia (los ocultos, con `.`, también). */
const IGNORED_NAMES = new Set(["__macosx", "thumbs.db", "desktop.ini"]);

const isIgnored = (name: string) => name.startsWith(".") || IGNORED_NAMES.has(name.toLowerCase());

/** Orden natural del spec (F1 §4.3): `foto2` antes de `foto10`, sin distinguir mayúsculas. */
const collator = new Intl.Collator("es", { numeric: true, sensitivity: "base" });

/**
 * Con empate (`Foto1.jpg` y `foto1.jpg`), la comparación binaria decide. Así el orden, y con él
 * la portada por defecto, no depende del orden en que el sistema de archivos lista la carpeta.
 */
export const naturalOrder = (a: string, b: string) =>
  collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/** Errores de un archivo que se omiten con `unreadable`; los demás son de la carpeta o el disco. */
const UNREADABLE_CODES = new Set(["EACCES", "EPERM", "ENOENT"]);

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? String(error.code) : undefined;

/** `true` si `path` queda estrictamente dentro de `base` (no es la misma carpeta). */
function isInside(base: string, path: string): boolean {
  const rel = relative(base, path);
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * `MediaFileSource` sobre una carpeta local (la de `--media` o el zip ya extraído). Los mensajes
 * llevan la carpeta relativa, nunca la ruta absoluta de la raíz.
 */
export function createMediaFolderSource(
  rootDir: string,
  options: MediaFolderSourceOptions,
): MediaFileSource {
  const root = resolve(rootDir);

  const invalidFolder = (folder: string) =>
    new AppError("MEDIA_FOLDER_INVALID", `La carpeta de medios "${folder}" no es válida`, {
      details: { folder },
    });

  const folderError = (folder: string, error: unknown) => {
    const code = errorCode(error);
    return code === "ENOENT" || code === "ENOTDIR"
      ? new AppError("MEDIA_FOLDER_NOT_FOUND", `No existe la carpeta de medios "${folder}"`, {
          details: { folder },
          cause: error,
        })
      : new AppError(
          "MEDIA_FOLDER_UNREADABLE",
          `No se pudo leer la carpeta de medios "${folder}"`,
          { details: { folder }, cause: error },
        );
  };

  /**
   * Carpeta real, verificando que quede dentro de la raíz (`carpeta_medios` viene del Excel):
   * primero en el texto de la ruta y después con `realpath`, porque `O_NOFOLLOW` solo protege el
   * último tramo y una subcarpeta enlazada (`root/link -> ../afuera`) sacaría la lectura de la raíz.
   */
  async function resolveFolder(folder: string): Promise<{ dir: string; prefix: string }> {
    const dir = resolve(root, folder);
    if (!folder.trim() || !isInside(root, dir)) throw invalidFolder(folder);

    let realRoot: string;
    let realDir: string;
    try {
      realRoot = await realpath(root);
      realDir = await realpath(dir);
    } catch (error) {
      throw folderError(folder, error);
    }
    if (!isInside(realRoot, realDir)) throw invalidFolder(folder);
    return { dir: realDir, prefix: relative(root, dir).split(sep).join("/") };
  }

  async function readFolder(dir: string, folder: string) {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch (error) {
      throw folderError(folder, error);
    }
  }

  /** Lee un archivo en streaming; un fallo es `MEDIA_FILE_UNREADABLE` (lo deja pasar `putStream`). */
  async function* openFile(path: string, relPath: string): AsyncIterable<Uint8Array> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, READ_FLAGS);
      yield* handle.createReadStream({ autoClose: false });
    } catch (error) {
      throw new AppError("MEDIA_FILE_UNREADABLE", `No se pudo leer ${relPath}`, {
        details: { relPath },
        cause: error,
      });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /**
   * Revisa tipo, tamaño y firma, y calcula el sha256 en streaming. Sin permiso, o si el archivo
   * desapareció, lo omite; otro error (`EIO`, `EMFILE`) es del disco y lanza
   * `MEDIA_FOLDER_UNREADABLE` en vez de esconderse como un archivo omitido.
   */
  async function inspect(
    path: string,
    relPath: string,
    folder: string,
  ): Promise<MediaFile | SkippedMediaFile> {
    const type = mediaTypeOf(relPath);
    if (!type) return { relPath, reason: "unsupported_type" };

    let handle: FileHandle | undefined;
    try {
      handle = await open(path, READ_FLAGS);
      const info = await handle.stat();
      if (!info.isFile()) return { relPath, reason: "not_a_file" };
      if (info.size === 0) return { relPath, reason: "empty" };
      if (type.kind === "video" && info.size > options.maxVideoBytes) {
        return { relPath, reason: "too_large" };
      }

      const head = new Uint8Array(SIGNATURE_BYTES);
      const { bytesRead } = await handle.read(head, 0, SIGNATURE_BYTES, 0);
      if (!type.matches(head.subarray(0, bytesRead))) {
        return { relPath, reason: "signature_mismatch" };
      }

      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
        hash.update(chunk);
        bytes += chunk.byteLength;
      }
      return {
        relPath,
        kind: type.kind,
        mime: type.mime,
        extension: type.extension,
        bytes,
        sha256: hash.digest("hex"),
        open: () => openFile(path, relPath),
      };
    } catch (error) {
      const code = errorCode(error);
      // ELOOP: lo cambiaron por un enlace simbólico después del listado (O_NOFOLLOW).
      if (code === "ELOOP") return { relPath, reason: "not_a_file" };
      if (code && UNREADABLE_CODES.has(code)) return { relPath, reason: "unreadable" };
      throw new AppError("MEDIA_FOLDER_UNREADABLE", `No se pudo leer ${relPath}`, {
        details: { folder, relPath },
        cause: error,
      });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  return {
    async list(folder) {
      const { dir, prefix } = await resolveFolder(folder);
      const entries = (await readFolder(dir, folder))
        .filter((entry) => !isIgnored(entry.name))
        .sort((a, b) => naturalOrder(a.name, b.name));

      const listing: MediaFolderListing = { files: [], skipped: [] };
      for (const entry of entries) {
        const relPath = `${prefix}/${entry.name}`;
        // `readdir` no sigue enlaces: un enlace simbólico no es `isFile()`.
        const result = entry.isFile()
          ? await inspect(join(dir, entry.name), relPath, folder)
          : ({ relPath, reason: "not_a_file" } as const);
        if ("reason" in result) listing.skipped.push(result);
        else listing.files.push(result);
      }
      return listing;
    },
  };
}
