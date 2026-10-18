import {
  type Env,
  EnvError,
  EnvFileError,
  type EnvIssue,
  loadEnv,
  loadEnvFile,
} from "@agentsales/config";

export type EnvResult =
  | { ok: true; env: Env }
  | { ok: false; fileFound: boolean; issues: readonly EnvIssue[] };

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
  } catch (error) {
    // `ENV_FILE` que no existe (spec F8 §4.2): el mensaje nombra el archivo, nunca su contenido.
    if (error instanceof EnvFileError) {
      return {
        ok: false,
        fileFound: false,
        issues: [{ variable: "ENV_FILE", message: error.message }],
      };
    }
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
