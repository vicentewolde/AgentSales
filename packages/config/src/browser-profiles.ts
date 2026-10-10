import { isAbsolute, join, relative, resolve } from "node:path";
import { EnvError } from "./env.js";

/**
 * La carpeta de los perfiles del navegador de Marketplace, absoluta (spec F5 §4.2, ADR-0017): expande
 * `~/` con `homeDir` y rechaza una carpeta dentro del proyecto (`workspaceRoot`), porque el perfil
 * guarda la sesión de Facebook. `loadEnv` ya exige una ruta absoluta o con `~/`; esto cubre una
 * absoluta que apunte al proyecto (sin distinguir mayúsculas en macOS; no sigue enlaces
 * simbólicos). Es el único camino para obtener la carpeta: el worker y `fb:smoke` la usan.
 * Lanza `EnvError` (sin mostrar la ruta).
 */
export function resolveBrowserProfilesDir(
  value: string,
  {
    homeDir,
    workspaceRoot,
    caseInsensitive = process.platform === "darwin",
  }: {
    homeDir: string;
    workspaceRoot: string | null;
    /** Por defecto en macOS, cuyo disco no distingue mayúsculas (`/Users/x/Dev` = `/Users/x/dev`). */
    caseInsensitive?: boolean;
  },
): string {
  const absolute = resolve(value.startsWith("~/") ? join(homeDir, value.slice(2)) : value);
  const fold = (path: string) => (caseInsensitive ? path.toLowerCase() : path);
  if (workspaceRoot !== null && isInside(fold(absolute), fold(resolve(workspaceRoot)))) {
    throw new EnvError([
      {
        variable: "BROWSER_PROFILES_DIR",
        message:
          "no puede estar dentro del proyecto: guarda la sesión de Facebook (usa el valor por defecto, ~/.agentsales/browser-profiles)",
      },
    ]);
  }
  return absolute;
}

/** Si `path` es `dir` o está dentro de `dir`. */
function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
