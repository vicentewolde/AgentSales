import { randomUUID } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AppError, type OpenedMedia, type RunImportDeps } from "@agentsales/core";
import { createMediaFolderSource, extractZip } from "@agentsales/importers";

/** Directorios de staging de más de esto se borran al arrancar, sea cual sea su run (§4.3). */
export const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Un directorio sin run en la base se borra solo si tiene más de esto: la API escribe `input/`
 * justo antes de crear el run (T11), y un worker que arranca en ese momento no debe borrarlo.
 */
export const STAGING_ORPHAN_GRACE_MS = 10 * 60 * 1000;

/** Estado del run de un directorio de staging, para la limpieza al arrancar. */
export type StagingRunState = "open" | "closed" | "missing";

/** Los runs son uuid: así un id nunca arma una ruta fuera del staging. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StagingOptions = {
  /** `<workspace>/tmp/imports` (spec F1 §4.1). */
  root: string;
  /** `MAX_VIDEO_MB` en bytes, para el lector de medios. */
  maxVideoBytes: number;
};

export type Staging = {
  /**
   * `<root>/{runId}`: `input/` (lo que subió la API) y `extracted-{uuid}/` (el zip de un intento:
   * cada intento tiene el suyo, así dos intentos solapados no se pisan).
   */
  dirOf(runId: string): string;
  openMedia: RunImportDeps["openMedia"];
  /** Borra `<root>/{runId}` completo (al llegar a un estado terminal). No falla si no existe. */
  discard(runId: string): Promise<void>;
  /**
   * Al arrancar el worker borra:
   * - los directorios de más de 24 h, sin consultar la base (sirve aunque Neon no responda);
   * - con `stateOf`, los de runs terminados, y los sin run de más de 10 minutos.
   * Un error en una entrada (la base, el disco) la deja para el próximo arranque y sigue con las
   * demás. Devuelve los ids borrados.
   */
  cleanup(stateOf?: (runId: string) => Promise<StagingRunState>, now?: number): Promise<string[]>;
};

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? String(error.code) : undefined;

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

/**
 * Raíz de medios dentro del zip extraído. Si ninguna carpeta pedida está en la raíz pero el zip
 * trae una sola carpeta que sí las tiene (macOS → Comprimir "medios"), la raíz es esa carpeta.
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

export function createStaging(options: StagingOptions): Staging {
  const dirOf = (runId: string) => {
    if (!RUN_ID.test(runId)) {
      throw new AppError("IMPORT_RUN_INVALID", `Id de carga inválido: ${runId}`);
    }
    return join(options.root, runId);
  };
  const remove = (path: string) => rm(path, { recursive: true, force: true });
  const sourceOf = (root: string) =>
    createMediaFolderSource(root, { maxVideoBytes: options.maxVideoBytes });

  return {
    dirOf,

    async openMedia({ runId, mediaDir, folders }) {
      if (mediaDir === null) return { source: null, close: async () => {} };
      const name = basename(mediaDir);
      const info = await stat(mediaDir).catch((error: unknown) => {
        if (errorCode(error) === "ENOENT") {
          throw new AppError(
            "IMPORT_FILE_NOT_FOUND",
            `No existe la carpeta o el zip de medios ${name}`,
            {
              details: { file: name },
              cause: error,
            },
          );
        }
        throw new AppError("IMPORT_FILE_INVALID", `No se pudo leer los medios ${name}`, {
          details: { file: name },
          cause: error,
        });
      });
      if (info.isDirectory()) return { source: sourceOf(mediaDir), close: async () => {} };
      if (!info.isFile() || !name.toLowerCase().endsWith(".zip")) {
        throw new AppError(
          "IMPORT_FILE_INVALID",
          `Los medios deben ser una carpeta o un .zip: ${name}`,
          {
            details: { file: name },
          },
        );
      }

      // Un directorio propio del intento, que se borra al terminarlo, falle o no (§4.3). Los de
      // un intento que murió los borran `discard` (estado terminal) o la limpieza al arrancar.
      const extracted = join(dirOf(runId), `extracted-${randomUUID()}`);
      try {
        await extractZip(mediaDir, extracted);
        const root = await mediaRootOf(extracted, folders);
        return { source: sourceOf(root), close: () => remove(extracted).catch(() => undefined) };
      } catch (error) {
        await remove(extracted).catch(() => undefined);
        throw error;
      }
    },

    async discard(runId) {
      await remove(dirOf(runId));
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
        // Solo directorios de runs: nada que no haya creado el staging.
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
