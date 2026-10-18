import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Sube desde `start` hasta encontrar `pnpm-workspace.yaml` y devuelve esa carpeta. */
export function findWorkspaceRoot(start: string = process.cwd()): string {
  let dir = start;
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`No se encontró pnpm-workspace.yaml desde ${start}`);
    }
    dir = parent;
  }
  return dir;
}

/** Error al elegir el archivo de entorno con `ENV_FILE` (spec F8 §4.2): nombra el archivo, nunca su contenido. */
export class EnvFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvFileError";
  }
}

/**
 * Carga el archivo de entorno en `process.env`, sin pisar variables ya definidas: `.env` de la raíz
 * del workspace o, con `ENV_FILE` (spec F8 §4.2, por ejemplo `ENV_FILE=.env.production`), ese
 * archivo, relativo a la raíz o absoluto. Devuelve `false` si no hay `.env` o no hay workspace (por
 * ejemplo, en CI o en el servidor, donde el entorno lo pone el proveedor). Un `ENV_FILE` que no
 * existe lanza `EnvFileError`: correr un script contra otra base por un error de tipeo sería peor.
 */
/**
 * El archivo de entorno de la API y del worker: siempre `.env` (o el entorno del proveedor). Un
 * `ENV_FILE` es solo para los scripts (spec F8, D12): si un `pnpm dev` lo heredara de la terminal, el
 * worker del Mac correría contra producción y se robaría sus trabajos (§4.6), así que se rechaza.
 */
export function loadAppEnvFile(
  root?: string,
  envFile: string | undefined = process.env.ENV_FILE,
): boolean {
  if (envFile !== undefined && envFile.trim() !== "") {
    throw new EnvFileError(
      `ENV_FILE=${envFile.trim()}: es solo para los scripts; la API y el worker usan .env (quita ENV_FILE de la terminal)`,
    );
  }
  return loadEnvFile(root, undefined);
}

export function loadEnvFile(
  root?: string,
  envFile: string | undefined = process.env.ENV_FILE,
): boolean {
  const chosen = envFile?.trim() === "" ? undefined : envFile?.trim();
  let dir = root;
  if (dir === undefined) {
    try {
      dir = findWorkspaceRoot();
    } catch {
      if (chosen !== undefined && !isAbsolute(chosen)) {
        throw new EnvFileError(`ENV_FILE=${chosen}: no se encontró la raíz del proyecto`);
      }
      if (chosen === undefined) return false;
      dir = "/";
    }
  }
  const path = chosen === undefined ? join(dir, ".env") : resolve(dir, chosen);
  if (!existsSync(path)) {
    if (chosen !== undefined) {
      throw new EnvFileError(`ENV_FILE=${chosen}: el archivo no existe`);
    }
    return false;
  }
  process.loadEnvFile(path);
  return true;
}
