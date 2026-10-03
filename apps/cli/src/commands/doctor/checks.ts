import type { HealthReport, PublishMode } from "@agentsales/core";
import { FFMPEG_MIN_VERSION, isSupportedFfmpeg, parseFfmpegVersion } from "@agentsales/media/tools";
import { apiHint, type HealthFetcher } from "../../api-client.js";
import type { EnvResult } from "../../env.js";

export type Level = "ok" | "warn" | "error";

export type CheckItem = {
  name: string;
  level: Level;
  detail: string;
  hint?: string;
  /** `danger`: se destaca en rojo aunque sea una advertencia (`PUBLISH_MODE=live`). */
  emphasis?: "danger";
};

/** Ejecuta un comando y devuelve su salida; lanza si no existe, falla o tarda demasiado. */
/** Ejecuta un comando; con `env`, el proceso recibe solo ese entorno (no el de la CLI). */
export type RunCommand = (
  command: string,
  args: readonly string[],
  options?: { env?: Record<string, string> },
) => Promise<string>;

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

/**
 * ffmpeg o ffprobe (spec F2 §4.8): que exista y sea 8.1 o más nuevo (las fotos HEIC del iPhone,
 * hechas de mosaicos, necesitan 8.1). Una versión que no se reconoce (un build de desarrollo) pasa.
 */
export async function checkFfmpegTool(
  run: RunCommand,
  name: "ffmpeg" | "ffprobe",
  path: string,
): Promise<CheckItem> {
  const variable = name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
  let output: string;
  try {
    output = await run(path, ["-version"]);
  } catch (error) {
    return {
      name,
      level: "error",
      detail: `${path}: ${describeCommandError(error)}`,
      hint: `brew install ffmpeg (trae ffprobe), o ajusta ${variable} en .env`,
    };
  }
  const version = parseFfmpegVersion(output);
  if (!isSupportedFfmpeg(version)) {
    return {
      name,
      level: "error",
      detail: `${firstLine(output)} (se necesita ${FFMPEG_MIN_VERSION.major}.${FFMPEG_MIN_VERSION.minor} o más nueva)`,
      hint: "brew upgrade ffmpeg",
    };
  }
  return { name, level: "ok", detail: firstLine(output) };
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

/** Sesión de la CLI según `claude auth status --json`. */
type ClaudeSession = "plan" | "api-key" | "none" | "unknown";

/**
 * `plan` solo con la sesión de claude.ai (la que usa el adaptador `claude-cli`). Una API key
 * también da `loggedIn: true`, pero el adaptador no se la pasa a la CLI: no cuenta como sesión.
 */
function parseSession(output: string): ClaudeSession {
  try {
    const status: unknown = JSON.parse(output);
    if (typeof status !== "object" || status === null || !("loggedIn" in status)) return "unknown";
    if (status.loggedIn !== true) return "none";
    const method = "authMethod" in status ? status.authMethod : undefined;
    return method === "claude.ai" || method === "oauth_token" ? "plan" : "api-key";
  } catch {
    return "unknown";
  }
}

/**
 * La sesión de la CLI, sin gastar cuota, con el mismo entorno mínimo que usa el adaptador (sin
 * `ANTHROPIC_API_KEY` ni nada del `.env`). Sin sesión, `claude auth status` sale con código 1 y el
 * JSON igual va en stdout, que trae el error de `execFile`.
 */
async function claudeSession(
  run: RunCommand,
  cliPath: string,
  env: Record<string, string>,
): Promise<ClaudeSession> {
  try {
    return parseSession(await run(cliPath, ["auth", "status", "--json"], { env }));
  } catch (error) {
    const stdout =
      typeof error === "object" && error !== null && "stdout" in error ? error.stdout : undefined;
    return typeof stdout === "string" ? parseSession(stdout) : "unknown";
  }
}

const CLAUDE_LOGIN_HINT =
  "Abre `claude` en una terminal e inicia sesión con /login (docs/07-checklist-cuentas.md)";

/** La CLI de Claude (proveedor `claude-cli`, spec F2 §4.8): que exista y que tenga sesión. */
export async function checkClaude(
  run: RunCommand,
  cliPath: string,
  env: Record<string, string>,
): Promise<CheckItem> {
  let version: string;
  try {
    version = firstLine(await run(cliPath, ["--version"], { env }));
  } catch (error) {
    return {
      name: "Claude Code",
      level: "warn",
      detail: `${describeCommandError(error)}; se necesita para generar contenido (F2)`,
      hint: "Instala Claude Code e inicia sesión, o ajusta CLAUDE_CLI_PATH en .env",
    };
  }
  const session = await claudeSession(run, cliPath, env);
  if (session === "plan") {
    return { name: "Claude Code", level: "ok", detail: `${version} · sesión iniciada` };
  }
  const detail: Record<Exclude<ClaudeSession, "plan">, string> = {
    none: "sin sesión: no se puede generar contenido",
    "api-key": "solo con una API key, que el sistema no le pasa: inicia sesión con tu plan",
    unknown: "no se pudo revisar la sesión",
  };
  return {
    name: "Claude Code",
    level: "warn",
    detail: `${version} · ${detail[session]}`,
    hint: CLAUDE_LOGIN_HINT,
  };
}
