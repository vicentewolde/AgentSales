import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Versión del `package.json` de la API; sube desde este archivo (funciona en `src/` y `dist/`). */
export function readApiVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      return "0.0.0";
    }
    dir = parent;
  }
  const pkg: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return typeof pkg === "object" &&
    pkg !== null &&
    "version" in pkg &&
    typeof pkg.version === "string"
    ? pkg.version
    : "0.0.0";
}
