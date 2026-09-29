import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

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

/**
 * Carga el `.env` de la raíz del workspace en `process.env`, sin pisar variables ya definidas.
 * Devuelve `false` si el archivo no existe (por ejemplo, en CI).
 */
export function loadEnvFile(root: string = findWorkspaceRoot()): boolean {
  const path = join(root, ".env");
  if (!existsSync(path)) {
    return false;
  }
  process.loadEnvFile(path);
  return true;
}
