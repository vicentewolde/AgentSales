import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  AppError,
  deleteImportObjects,
  isAppError,
  type MediaStorage,
  type RunImportDeps,
} from "@agentsales/core";
import { createMediaFolderSource } from "./media-folder.js";
import { readListingsWorkbook } from "./xlsx-reader.js";
import { entryTargetPath, extractZip } from "./zip.js";

// La carpeta temporal del worker para las cargas (spec F8 §4.4, ADR-0025): el worker baja de R2 la
// planilla y los medios de cada intento a un directorio propio, los lee con los lectores de
// siempre y lo borra al terminar el intento. Ya no hay disco compartido con la API.

/** Directorios de más de esto se borran al arrancar, sea cual sea su carga (spec F1 §4.3). */
export const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Un directorio sin carga en la base se borra solo si tiene más de esto. */
export const STAGING_ORPHAN_GRACE_MS = 10 * 60 * 1000;

/** `<workspace>/tmp/imports`: los temporales de las cargas del worker. */
export const stagingRootOf = (workspaceRoot: string) => join(workspaceRoot, "tmp", "imports");

/** Estado de la carga de un directorio, para la limpieza al arrancar. */
export type StagingRunState = "open" | "closed" | "missing";

/** Las cargas son uuid: así un id nunca arma una ruta fuera de la carpeta. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StagingOptions = {
  /** `<workspace>/tmp/imports`. */
  root: string;
  /** El bucket de las cargas (bajar los archivos y borrarlos al terminar). */
  storage: Pick<MediaStorage, "getStream" | "list" | "delete">;
  /** `MAX_VIDEO_MB` en bytes, para el lector de medios. */
  maxVideoBytes: number;
};

export type Staging = {
  /** `<root>/{runId}`: un directorio por intento adentro (`sheet-…`, `media-…`). */
  dirOf(runId: string): string;
  readSheet: RunImportDeps["readSheet"];
  openMedia: RunImportDeps["openMedia"];
  /**
   * Borra los archivos de la carga en R2 (`imports/{id}/`) y su directorio local. Solo al llegar a
   * un estado terminal. No falla si no hay nada (sí si R2 no responde: quien llama lo ignora y la
   * limpieza de cada hora lo recoge).
   */
  discard(runId: string): Promise<void>;
  /**
   * Al arrancar el worker borra los directorios locales de más de 24 h (sin consultar la base) y,
   * con `stateOf`, los de cargas terminadas y los sin carga de más de 10 minutos. Un error en una
   * entrada la deja para el próximo arranque. Devuelve los ids borrados.
   */
  cleanup(stateOf?: (runId: string) => Promise<StagingRunState>, now?: number): Promise<string[]>;
};

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? String(error.code) : undefined;

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

/**
 * Raíz de medios dentro de lo bajado o extraído. Si ninguna carpeta pedida está en la raíz pero
 * hay una sola carpeta que sí las tiene (macOS → Comprimir "medios"), la raíz es esa carpeta.
 */
async function mediaRootOf(extracted: string, requested: readonly string[]): Promise<string> {
  // Las carpetas vienen del Excel: se ignoran las vacías o las que salen de la raíz (`..`, `.`),
  // que darían un "sí" falso. `ingestMedia` igual las rechaza después (`MEDIA_FOLDER_INVALID`).
  const folders = requested.filter((folder) => {
    const rel = relative(extracted, resolve(extracted, folder));
    return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  });
  if (folders.length === 0) return extracted;
  const atRoot = await Promise.all(folders.map((folder) => isDirectory(join(extracted, folder))));
  if (atRoot.some(Boolean)) return extracted;
  const entries = await readdir(extracted, { withFileTypes: true });
  const visible = entries.filter((entry) => !entry.name.startsWith("."));
  const [single] = visible;
  if (visible.length !== 1 || single === undefined || !single.isDirectory()) return extracted;
  const inner = join(extracted, single.name);
  const inside = await Promise.all(folders.map((folder) => isDirectory(join(inner, folder))));
  return inside.some(Boolean) ? inner : extracted;
}

/**
 * Baja un objeto de R2 a `dest`, en streaming, contando bytes y (si viene) calculando su sha256:
 * - no existe (`STORAGE_NOT_FOUND`): `IMPORT_FILE_NOT_FOUND`, no reintentable (se borró: por
 *   ejemplo, la carga se cerró por abandonada);
 * - otro tamaño u otro sha256 que los anunciados: `IMPORT_FILE_INVALID` (R2 ya debería haberlo
 *   rechazado al subir; si no lo hizo, el worker lo valida aquí, ADR-0025);
 * - un corte de R2 (`STORAGE_UNAVAILABLE`) se propaga: es reintentable y el intento siguiente
 *   vuelve a bajarlo.
 */
async function download(
  storage: StagingOptions["storage"],
  key: string,
  dest: string,
  expected: { name: string; size: number; sha256?: string | undefined },
): Promise<void> {
  let body: AsyncIterable<Uint8Array>;
  try {
    body = await storage.getStream(key);
  } catch (error) {
    if (isAppError(error) && error.code === "STORAGE_NOT_FOUND") {
      throw new AppError("IMPORT_FILE_NOT_FOUND", `No está el archivo subido ${expected.name}`, {
        details: { file: expected.name },
        cause: error,
      });
    }
    throw error;
  }
  const hash = expected.sha256 === undefined ? null : createHash("sha256");
  let bytes = 0;
  const tooBig = () =>
    new AppError(
      "IMPORT_FILE_INVALID",
      `El archivo subido ${expected.name} no es el que se anunció`,
      {
        details: { file: expected.name, expected: expected.size, received: bytes },
      },
    );
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      // Más bytes que los anunciados: se corta ya, sin bajar el resto.
      if (bytes > expected.size) {
        callback(tooBig());
        return;
      }
      hash?.update(chunk);
      callback(null, chunk);
    },
  });
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(Readable.from(body), meter, createWriteStream(dest, { flags: "wx" }));
  if (bytes !== expected.size || (hash !== null && hash.digest("hex") !== expected.sha256)) {
    throw new AppError(
      "IMPORT_FILE_INVALID",
      `El archivo subido ${expected.name} no es el que se anunció`,
      { details: { file: expected.name, expected: expected.size, received: bytes } },
    );
  }
}

export function createStaging(options: StagingOptions): Staging {
  const dirOf = (runId: string) => {
    if (!RUN_ID.test(runId)) {
      throw new AppError("IMPORT_RUN_INVALID", `Id de carga inválido: ${runId}`);
    }
    return join(options.root, runId);
  };
  const remove = (path: string) => rm(path, { recursive: true, force: true });
  /** Un directorio propio del intento: dos intentos solapados no se pisan. */
  const attemptDir = (runId: string, kind: "sheet" | "media") =>
    join(dirOf(runId), `${kind}-${randomUUID()}`);

  return {
    dirOf,

    async readSheet({ runId, input }) {
      const dir = attemptDir(runId, "sheet");
      try {
        const path = join(dir, "planilla.xlsx");
        await download(options.storage, input.xlsx.key, path, input.xlsx);
        return await readListingsWorkbook(path);
      } finally {
        await remove(dir).catch(() => undefined);
      }
    },

    async openMedia({ runId, media, folders }) {
      if (media === null) return { source: null, close: async () => {} };
      const dir = attemptDir(runId, "media");
      const close = () => remove(dir).catch(() => undefined);
      try {
        let root: string;
        if (media.kind === "zip") {
          // Nombre fijo (como la planilla): el de la carga viene del jsonb.
          const zip = join(dir, "medios.zip");
          await download(options.storage, media.key, zip, media);
          const extracted = join(dir, "extraido");
          await extractZip(zip, extracted);
          // El zip ya no hace falta: con 4 GB, el disco tendría dos copias.
          await rm(zip, { force: true });
          root = extracted;
        } else {
          root = join(dir, "carpeta");
          for (const file of media.files) {
            // Las rutas ya se validaron al pedir la subida (core); esto es la segunda barrera.
            const target = entryTargetPath(root, file.path);
            if (target === null || target === root) {
              throw new AppError(
                "IMPORT_FILE_INVALID",
                "Un archivo de la carpeta tiene una ruta no permitida",
                {
                  details: { file: file.path.slice(0, 200) },
                },
              );
            }
            await download(options.storage, `${media.prefix}${file.path}`, target, {
              name: file.path,
              size: file.size,
              sha256: file.sha256,
            });
          }
          await mkdir(root, { recursive: true });
        }
        const mediaRoot = await mediaRootOf(root, folders);
        return {
          source: createMediaFolderSource(mediaRoot, { maxVideoBytes: options.maxVideoBytes }),
          close,
        };
      } catch (error) {
        await close();
        throw error;
      }
    },

    async discard(runId) {
      await remove(dirOf(runId));
      await deleteImportObjects(options.storage, runId);
    },

    async cleanup(stateOf, now = Date.now()) {
      const entries = await readdir(options.root, { withFileTypes: true }).catch(
        (error: unknown) => {
          if (errorCode(error) === "ENOENT") return [];
          throw error;
        },
      );
      const removed: string[] = [];
      for (const entry of entries) {
        // Solo directorios de cargas: nada que no haya creado el staging.
        if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
        const dir = join(options.root, entry.name);
        try {
          const age = now - (await stat(dir)).mtimeMs;
          let drop = age > STAGING_MAX_AGE_MS;
          if (!drop && stateOf !== undefined) {
            const state = await stateOf(entry.name);
            drop = state === "closed" || (state === "missing" && age > STAGING_ORPHAN_GRACE_MS);
          }
          if (drop) {
            await remove(dir);
            removed.push(entry.name);
          }
        } catch {
          // Esta entrada queda para el próximo arranque; las demás siguen.
        }
      }
      return removed;
    },
  };
}
