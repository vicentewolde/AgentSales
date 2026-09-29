import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Sube desde este archivo hasta la carpeta del paquete (la que tiene `package.json`). */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("No se encontró el package.json de @agentsales/db");
    }
    dir = parent;
  }
  return dir;
}

/**
 * Carpeta de migraciones SQL generadas por drizzle-kit (`pnpm db:generate`). Se resuelve desde
 * la raíz del paquete para que funcione igual desde `src/` (tsx) que desde `dist/src/`.
 */
export const MIGRATIONS_FOLDER = join(packageRoot(), "drizzle");
