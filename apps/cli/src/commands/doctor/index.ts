import { claudeCliEnv } from "@agentsales/llm";
import { chromiumStatus } from "@agentsales/media/tools";
import type { Command } from "commander";
import { createHealthFetcher, type HealthFetcher } from "../../api-client.js";
import type { Colors } from "../../colors.js";
import type { CliContext } from "../../context.js";
import { type EnvResult, loadEnvironment } from "../../env.js";
import {
  type CheckItem,
  checkChromium,
  checkClaude,
  checkEnv,
  checkFfmpegTool,
  checkInstagram,
  checkMercadoLibre,
  checkNode,
  checkPublishMode,
  checkServices,
  checkUfSource,
  type Level,
  type RunCommand,
} from "./checks.js";
import { runCommand } from "./system.js";

export type DoctorDeps = {
  nodeVersion: string;
  env: EnvResult;
  fetchHealth: HealthFetcher;
  run: RunCommand;
  /** El Chromium que pide Playwright (`chromiumStatus`); `null` si Playwright no cargó. */
  chromium: { path: string; installed: boolean } | null;
  /** Entorno del proceso: la CLI de Claude recibe solo las variables permitidas (`claudeCliEnv`). */
  processEnv: Readonly<Record<string, string | undefined>>;
};

export type DoctorReport = { items: CheckItem[]; exitCode: 0 | 1 };

/** Revisa el entorno completo. Sale con 1 si algún ítem es error; las advertencias no cuentan. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const services = await checkServices(deps.fetchHealth);
  const publishMode = checkPublishMode(
    services.report?.publishMode,
    deps.env.ok ? deps.env.env.PUBLISH_MODE : undefined,
  );
  const ffmpegPath = deps.env.ok ? deps.env.env.FFMPEG_PATH : "ffmpeg";
  const ffprobePath = deps.env.ok ? deps.env.env.FFPROBE_PATH : "ffprobe";
  const instagram = checkInstagram(deps.env);
  const mercadoLibre = checkMercadoLibre(deps.env);
  const ufSource = checkUfSource(deps.env);
  const items: CheckItem[] = [
    checkNode(deps.nodeVersion),
    checkEnv(deps.env),
    ...(publishMode ? [publishMode] : []),
    ...(instagram ? [instagram] : []),
    ...(mercadoLibre ? [mercadoLibre] : []),
    ...(ufSource ? [ufSource] : []),
    ...services.items,
    await checkFfmpegTool(deps.run, "ffmpeg", ffmpegPath),
    await checkFfmpegTool(deps.run, "ffprobe", ffprobePath),
    checkChromium(deps.chromium),
    await checkClaude(
      deps.run,
      deps.env.ok ? deps.env.env.CLAUDE_CLI_PATH : "claude",
      claudeCliEnv(deps.processEnv),
    ),
  ];
  return { items, exitCode: items.some((item) => item.level === "error") ? 1 : 0 };
}

const SYMBOL: Record<Level, string> = { ok: "✓", warn: "⚠", error: "✗" };

export function renderDoctor(report: DoctorReport, c: Colors): string {
  const paint: Record<Level, (text: string) => string> = {
    ok: c.green,
    warn: c.yellow,
    error: c.red,
  };
  const width = Math.max(...report.items.map((item) => item.name.length));
  const lines = report.items.flatMap((item) => {
    const detail =
      item.emphasis === "danger" ? c.bold(c.bgRed(c.white(` ${item.detail} `))) : item.detail;
    const line = `${paint[item.level](SYMBOL[item.level])} ${c.bold(item.name.padEnd(width))}  ${detail}`;
    return item.hint ? [line, `  ${c.dim(`→ ${item.hint}`)}`] : [line];
  });
  const errors = report.items.filter((item) => item.level === "error").length;
  const warnings = report.items.filter((item) => item.level === "warn").length;
  const summary =
    errors > 0
      ? c.red(`${errors} error(es), ${warnings} advertencia(s)`)
      : c.green(`Todo en orden${warnings > 0 ? ` (${warnings} advertencia(s))` : ""}`);
  return [c.bold("agentsales doctor"), "", ...lines, "", summary].join("\n");
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("doctor")
    .description("Revisa el entorno: .env, API, base, almacenamiento, cola y herramientas")
    .action(async () => {
      const report = await runDoctor({
        nodeVersion: process.version,
        env: loadEnvironment(),
        fetchHealth: createHealthFetcher(ctx.api()),
        run: runCommand,
        chromium: await chromiumStatus().catch(() => null),
        processEnv: process.env,
      });
      ctx.print(renderDoctor(report, ctx.colors));
      process.exitCode = report.exitCode;
    });
}
