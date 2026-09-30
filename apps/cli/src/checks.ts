import type { HealthReport } from "@agentsales/api";
import type { Env, EnvIssue } from "@agentsales/config";
import type { HealthFetcher } from "./api-client.js";

export type Level = "ok" | "warn" | "error";

export type CheckItem = { name: string; level: Level; detail: string; hint?: string };

export type EnvResult =
  | { ok: true; env: Env }
  | { ok: false; fileFound: boolean; issues: readonly EnvIssue[] };

/** Ejecuta un comando y devuelve su salida; lanza si no existe o falla. */
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
  if (!result.fileFound && result.issues.length > 0) {
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

export function checkPublishMode(env: Env): CheckItem {
  return env.PUBLISH_MODE === "live"
    ? {
        name: "PUBLISH_MODE",
        level: "warn",
        detail: "live: las publicaciones son reales",
        hint: "Vuelve a dry-run en .env si no estás publicando de verdad",
      }
    : { name: "PUBLISH_MODE", level: "ok", detail: "dry-run (no se publica nada)" };
}

const SERVICE_LABELS = { db: "Base de datos", storage: "Almacenamiento", queue: "Cola" } as const;

/** API más db, storage y cola, todo desde `/health` (la CLI no duplica los checks). */
export async function checkServices(fetchHealth: HealthFetcher): Promise<CheckItem[]> {
  let report: HealthReport;
  try {
    report = await fetchHealth();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [
      {
        name: "API",
        level: "error",
        detail: `no responde (${reason})`,
        hint: "Levántala con pnpm dev",
      },
      ...Object.values(SERVICE_LABELS).map(
        (name): CheckItem => ({ name, level: "error", detail: "sin datos: la API no responde" }),
      ),
    ];
  }
  const api: CheckItem = {
    name: "API",
    level: "ok",
    detail: `responde (versión ${report.version}, ${report.status})`,
  };
  const services = (Object.keys(SERVICE_LABELS) as (keyof typeof SERVICE_LABELS)[]).map(
    (key): CheckItem => {
      const result = report.checks[key];
      const name = SERVICE_LABELS[key];
      if (!result.ok) {
        return {
          name,
          level: "error",
          detail: result.error ?? "falló",
          ...(key === "queue" ? { hint: "Arranca el worker una vez (pnpm dev)" } : {}),
        };
      }
      const detail =
        key === "queue"
          ? `inicializada, ${result.latencyMs} ms (no indica si el worker está corriendo)`
          : `${result.latencyMs} ms`;
      return { name, level: "ok", detail };
    },
  );
  return [api, ...services];
}

const firstLine = (output: string) => output.split("\n")[0]?.trim() ?? "";

export async function checkFfmpeg(run: RunCommand, ffmpegPath: string): Promise<CheckItem> {
  try {
    return { name: "ffmpeg", level: "ok", detail: firstLine(await run(ffmpegPath, ["-version"])) };
  } catch {
    return {
      name: "ffmpeg",
      level: "error",
      detail: `no se pudo ejecutar ${ffmpegPath}`,
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
  } catch {
    return {
      name: "Claude Code",
      level: "warn",
      detail: "no encontrado; se necesita en F2 (generación de contenido)",
      hint: "Instala Claude Code e inicia sesión (docs/07-checklist-cuentas.md)",
    };
  }
}
