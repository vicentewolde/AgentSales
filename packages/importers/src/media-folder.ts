import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open, readdir } from "node:fs/promises";
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

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? String(error.code) : undefined;

/**
 * `MediaFileSource` sobre una carpeta local (la de `--media` o el zip ya extraído). Los mensajes
 * llevan la carpeta relativa, nunca la ruta absoluta de la raíz.
 */
export function createMediaFolderSource(
  rootDir: string,
  options: MediaFolderSourceOptions,
): MediaFileSource {
  const root = resolve(rootDir);

  /** Carpeta absoluta, verificando que quede dentro de la raíz (`carpeta_medios` viene del Excel). */
  function resolveFolder(folder: string): { dir: string; prefix: string } {
    const dir = resolve(root, folder);
    const rel = relative(root, dir);
    if (!folder.trim() || !rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new AppError("MEDIA_FOLDER_INVALID", `La carpeta de medios "${folder}" no es válida`, {
        details: { folder },
      });
    }
    return { dir, prefix: rel.split(sep).join("/") };
  }

  async function readFolder(dir: string, folder: string) {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new AppError("MEDIA_FOLDER_NOT_FOUND", `No existe la carpeta de medios "${folder}"`, {
          details: { folder },
          cause: error,
        });
      }
      throw new AppError(
        "MEDIA_FOLDER_UNREADABLE",
        `No se pudo leer la carpeta de medios "${folder}"`,
        { details: { folder }, cause: error },
      );
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

  /** Revisa tipo, tamaño y firma, y calcula el sha256 en streaming. */
  async function inspect(path: string, relPath: string): Promise<MediaFile | SkippedMediaFile> {
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
        bytes,
        sha256: hash.digest("hex"),
        open: () => openFile(path, relPath),
      };
    } catch (error) {
      // ELOOP: era un enlace simbólico (O_NOFOLLOW); el resto, permisos o errores de disco.
      return { relPath, reason: errorCode(error) === "ELOOP" ? "not_a_file" : "unreadable" };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  return {
    async list(folder) {
      const { dir, prefix } = resolveFolder(folder);
      const entries = (await readFolder(dir, folder))
        .filter((entry) => !isIgnored(entry.name))
        .sort((a, b) => collator.compare(a.name, b.name));

      const listing: MediaFolderListing = { files: [], skipped: [] };
      for (const entry of entries) {
        const relPath = `${prefix}/${entry.name}`;
        // `readdir` no sigue enlaces: un enlace simbólico no es `isFile()`.
        const result = entry.isFile()
          ? await inspect(join(dir, entry.name), relPath)
          : ({ relPath, reason: "not_a_file" } as const);
        if ("reason" in result) listing.skipped.push(result);
        else listing.files.push(result);
      }
      return listing;
    },
  };
}
