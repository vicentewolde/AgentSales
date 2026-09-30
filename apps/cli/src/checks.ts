import type { Env, EnvIssue } from "@agentsales/config";
import type { HealthReport, PublishMode } from "@agentsales/core";
import { ApiCallError, type HealthFetcher } from "./api-client.js";

export type Level = "ok" | "warn" | "error";

export type CheckItem = {
  name: string;
  level: Level;
  detail: string;
  hint?: string;
  /** `danger`: se destaca en rojo aunque sea una advertencia (`PUBLISH_MODE=live`). */
  emphasis?: "danger";
};

export type EnvResult =
  | { ok: true; env: Env }
  | { ok: false; fileFound: boolean; issues: readonly EnvIssue[] };

/** Ejecuta un comando y devuelve su salida; lanza si no existe, falla o tarda demasiado. */
export type RunCommand = (command: string, args: readonly string[]) => Promise<string>;

const REQUIRED_NODE_MAJOR = 26;

export function checkNode(version: string): CheckItem {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  return major === REQUIRED_NODE_MAJOR
    ? { name: "Node", level: "ok", detail: version }
    : {
        name: "Node",
        level: "error",
        detail: `${version}; el proyecto usa Node ${REQUIRED_NODE_MAJOR}`,
        hint: `Instala Node ${REQUIRED_NODE_MAJOR} (ADR-0008)`,
      };
}

/** Nunca muestra valores: solo nombres de variables y el motivo. */
export function checkEnv(result: EnvResult): CheckItem {
  if (result.ok) {
    return { name: ".env", level: "ok", detail: "válido" };
  }
  if (!result.fileFound) {
    return {
      name: ".env",
      level: "error",
      detail: "no se encontró el archivo .env en la raíz",
      hint: "cp .env.example .env y completa las variables (docs/09-alta-neon-r2.md)",
    };
  }
  return {
    name: ".env",
    level: "error",
    detail: result.issues.map((issue) => `${issue.variable} (${issue.message})`).join("; "),
    hint: "Corrige esas variables en .env (ver .env.example)",
  };
}

/**
 * El modo que manda es el de la API en ejecución (`/health`); si no responde, el del `.env`.
 * Si no coinciden, es un error: la API se levantó con otra configuración.
 */
export function checkPublishMode(
  apiMode: PublishMode | undefined,
  envMode: PublishMode | undefined,
): CheckItem | null {
  const mode = apiMode ?? envMode;
  if (!mode) {
    return null;
  }
  if (apiMode && envMode && apiMode !== envMode) {
    return {
      name: "PUBLISH_MODE",
      level: "error",
      detail: `la API corre en ${apiMode} pero .env dice ${envMode}`,
      hint: "Reinicia pnpm dev para que la API tome el .env actual",
      ...(apiMode === "live" ? { emphasis: "danger" as const } : {}),
    };
  }
  const source = apiMode ? "según la API" : "según .env; la API no responde";
  return mode === "live"
    ? {
        name: "PUBLISH_MODE",
        level: "warn",
        detail: `LIVE: las publicaciones son reales (${source})`,
        hint: "Vuelve a dry-run en .env si no estás publicando de verdad",
        emphasis: "danger",
      }
    : { name: "PUBLISH_MODE", level: "ok", detail: `dry-run: no se publica nada (${source})` };
}

const SERVICES = {
  db: {
    name: "Base de datos",
    hint: "Neon puede estar despertando: reintenta; si sigue, revisa DATABASE_URL (conexión directa, sin -pooler)",
  },
  storage: {
    name: "Almacenamiento",
    hint: "Revisa las variables R2_* en .env y corre pnpm storage:check",
  },
  queue: { name: "Cola", hint: "Arranca el worker una vez (pnpm dev)" },
} as const;

type ServiceKey = keyof typeof SERVICES;

/** Sugerencia según el motivo por el que la API no respondió. */
export function apiHint(error: unknown): string {
  if (error instanceof ApiCallError && error.code === "HOST_NOT_ALLOWED") {
    return "La API rechazó el Host: revisa que API_PORT coincida con el de la API";
  }
  if (error instanceof ApiCallError && error.code === "UNEXPECTED_RESPONSE") {
    return "Otro proceso usa el puerto: ciérralo o cambia API_PORT, y levanta pnpm dev";
  }
  return "Levántala con pnpm dev";
}

/** API más db, storage y cola, todo desde `/health` (la CLI no duplica los checks). */
export async function checkServices(
  fetchHealth: HealthFetcher,
): Promise<{ items: CheckItem[]; report: HealthReport | null }> {
  let report: HealthReport;
  try {
    report = await fetchHealth();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      report: null,
      items: [
        { name: "API", level: "error", detail: `no responde: ${reason}`, hint: apiHint(error) },
        ...Object.values(SERVICES).map(
          ({ name }): CheckItem => ({
            name,
            level: "error",
            detail: "sin datos: la API no responde",
          }),
        ),
      ],
    };
  }
  const api: CheckItem = {
    name: "API",
    level: "ok",
    detail: `responde (versión ${report.version}, ${report.status})`,
  };
  const services = (Object.keys(SERVICES) as ServiceKey[]).map((key): CheckItem => {
    const result = report.checks[key];
    const { name, hint } = SERVICES[key];
    if (!result.ok) {
      return { name, level: "error", detail: result.error ?? "falló", hint };
    }
    const detail =
      key === "queue"
        ? `inicializada, ${result.latencyMs} ms (no indica si el worker está corriendo)`
        : `${result.latencyMs} ms`;
    return { name, level: "ok", detail };
  });
  return { report, items: [api, ...services] };
}

/** Motivo legible de un comando que falló (sin exponer la salida completa). */
export function describeCommandError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    if ("code" in error && error.code === "ENOENT") return "no encontrado";
    if ("killed" in error && error.killed === true) return "no respondió a tiempo";
    if ("code" in error && typeof error.code === "number") return `salió con código ${error.code}`;
  }
  return error instanceof Error ? error.message : String(error);
}

const firstLine = (output: string) => output.split("\n")[0]?.trim() || "(sin versión)";

export async function checkFfmpeg(run: RunCommand, ffmpegPath: string): Promise<CheckItem> {
  try {
    return { name: "ffmpeg", level: "ok", detail: firstLine(await run(ffmpegPath, ["-version"])) };
  } catch (error) {
    return {
      name: "ffmpeg",
      level: "error",
      detail: `${ffmpegPath}: ${describeCommandError(error)}`,
      hint: "brew install ffmpeg, o ajusta FFMPEG_PATH en .env",
    };
  }
}

export function checkChromium(chromiumDir: string | null): CheckItem {
  return chromiumDir
    ? { name: "Chromium (Playwright)", level: "ok", detail: chromiumDir }
    : {
        name: "Chromium (Playwright)",
        level: "warn",
        detail: "no instalado; se necesita en F5 (Marketplace)",
        hint: "En F5: pnpm exec playwright install chromium",
      };
}

export async function checkClaude(run: RunCommand): Promise<CheckItem> {
  try {
    return {
      name: "Claude Code",
      level: "ok",
      detail: firstLine(await run("claude", ["--version"])),
    };
  } catch (error) {
    return {
      name: "Claude Code",
      level: "warn",
      detail: `${describeCommandError(error)}; se necesita en F2 (generación de contenido)`,
      hint: "Instala Claude Code e inicia sesión (docs/07-checklist-cuentas.md)",
    };
  }
}
