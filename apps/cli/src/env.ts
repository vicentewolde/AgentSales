import { EnvError, loadEnv, loadEnvFile } from "@agentsales/config";
import type { EnvResult } from "./checks.js";

export const DEFAULT_API_PORT = 8787;

export type LoadEnvironmentOptions = {
  /** Raíz del workspace; por defecto se busca desde el directorio actual. */
  root?: string;
  /** Variables a validar; por defecto `process.env` (tras cargar el `.env`). */
  source?: Record<string, string | undefined>;
};

/**
 * Carga y valida el `.env`. Nunca lanza por el entorno: devuelve los problemas (solo nombres de
 * variables y motivos) para que `doctor` pueda seguir diagnosticando lo demás.
 */
export function loadEnvironment(options: LoadEnvironmentOptions = {}): EnvResult {
  let fileFound: boolean;
  try {
    fileFound = loadEnvFile(options.root);
  } catch {
    return {
      ok: false,
      fileFound: true,
      issues: [{ variable: ".env", message: "no se pudo leer el archivo" }],
    };
  }
  try {
    return { ok: true, env: loadEnv(options.source) };
  } catch (error) {
    if (error instanceof EnvError) {
      return { ok: false, fileFound, issues: error.issues };
    }
    throw error;
  }
}

/** Puerto de la API aunque el `.env` sea inválido, para poder diagnosticar igual. */
export function apiPort(
  env: EnvResult,
  source: Record<string, string | undefined> = process.env,
): number {
  if (env.ok) {
    return env.env.API_PORT;
  }
  const raw = source.API_PORT?.trim() ?? "";
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return port >= 1 && port <= 65535 ? port : DEFAULT_API_PORT;
}
