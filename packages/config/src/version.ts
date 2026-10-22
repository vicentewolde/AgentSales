import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findWorkspaceRoot } from "./env-file.js";

/**
 * La versión de AgentSales: la del `package.json` raíz del workspace (spec F9.5 §4.2). La usan la API
 * (la cabecera `X-AgentSales-Version` y `/health`) y la CLI (`--version` y la comparación con el
 * servidor): así las dos dicen lo mismo cuando son del mismo código. Sube desde `start` (por
 * defecto, desde este archivo: funciona en `src/` y `dist/`, también en la imagen); sin workspace o
 * sin versión, `0.0.0`.
 */
export function readProductVersion(start = dirname(fileURLToPath(import.meta.url))): string {
  let root: string;
  try {
    root = findWorkspaceRoot(start);
  } catch {
    return "0.0.0";
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return "0.0.0";
  }
  return typeof pkg === "object" &&
    pkg !== null &&
    "version" in pkg &&
    typeof pkg.version === "string"
    ? pkg.version
    : "0.0.0";
}
