import { findPgTool } from "@agentsales/db/backup";
// La subruta: la CLI no carga el SDK de Anthropic solo para el entorno de la CLI de Claude.
import { claudeCliEnv } from "@agentsales/llm/claude-cli";
import { chromiumStatus } from "@agentsales/media/tools";
import type { Command } from "commander";
import { createHealthFetcher, type HealthFetcher } from "../../api-client.js";
import type { Colors } from "../../colors.js";
import type { CliContext } from "../../context.js";
import { type EnvResult, loadEnvironment } from "../../env.js";
import type { ServerResolution } from "../../server.js";
import {
  type CheckItem,
  checkAnthropicModel,
  checkAutoPublish,
  checkBackup,
  checkChromium,
  checkClaude,
  checkEnv,
  checkEnvironment,
  checkFfmpegTool,
  checkInstagram,
  checkLlmKey,
  checkMercadoLibre,
  checkNode,
  checkPgDump,
  checkPublishMode,
  checkServer,
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
  /** Dónde está `pg_dump` (`findPgTool`, con `PG_BIN_DIR`); lanza si no está. */
  findPgDump?: (binDir: string | undefined) => string;
  now?: () => Date;
  /**
   * A qué servidor habla la CLI (spec F8 §4.5). Sin él, la API local de siempre. Con uno remoto,
   * `doctor` no revisa el `.env` ni las herramientas del worker en este Mac (son del servidor).
   */
  server?: ServerResolution;
};

export type DoctorReport = { items: CheckItem[]; exitCode: 0 | 1 };

/** Lo que la CLI revisa de un servidor remoto: el servidor por `/health`, del Mac solo Node. */
async function runRemoteDoctor(deps: DoctorDeps, server: ServerResolution): Promise<CheckItem[]> {
  const services = await checkServices(deps.fetchHealth, true);
  const report = services.report;
  const publishMode = checkPublishMode(report?.publishMode, undefined, true);
  const environment = checkEnvironment(report, true);
  const autoPublish = checkAutoPublish(report);
  const llmKey = checkLlmKey(report);
  const backup = checkBackup(report, (deps.now ?? (() => new Date()))());
  const withoutHint = ({ hint: _hint, ...item }: CheckItem): CheckItem => item;
  return [
    checkNode(deps.nodeVersion),
    checkServer(server),
    ...(environment ? [environment] : []),
    ...(publishMode ? [publishMode] : []),
    ...(autoPublish ? [autoPublish] : []),
    ...(llmKey
      ? [{ ...llmKey, hint: "agrega ANTHROPIC_API_KEY a los secretos del servidor" }]
      : []),
    ...services.items,
    // El respaldo del servidor no se arregla con `pnpm db:backup` del Mac.
    ...(backup ? [withoutHint(backup)] : []),
    {
      name: "Herramientas",
      level: "ok",
      detail:
        "ffmpeg, Chromium, pg_dump y la IA son del servidor: no se revisan desde aquí (los trae su imagen)",
    },
  ];
}

/** Revisa el entorno completo. Sale con 1 si algún ítem es error; las advertencias no cuentan. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  if (deps.server?.ok && deps.server.target.remote) {
    const items = await runRemoteDoctor(deps, deps.server);
    return { items, exitCode: items.some((item) => item.level === "error") ? 1 : 0 };
  }
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
  const backup = checkBackup(services.report, (deps.now ?? (() => new Date()))());
  const autoPublish = checkAutoPublish(services.report);
  const llmKey = checkLlmKey(services.report);
  const anthropicModel = checkAnthropicModel(deps.env);
  const pgBinDir = deps.env.ok ? deps.env.env.PG_BIN_DIR : undefined;
  const findPgDump =
    deps.findPgDump ??
    ((binDir: string | undefined) => findPgTool("pg_dump", binDir === undefined ? {} : { binDir }));
  const environment = checkEnvironment(services.report, false);
  const items: CheckItem[] = [
    checkNode(deps.nodeVersion),
    ...(deps.server === undefined ? [] : [checkServer(deps.server)]),
    checkEnv(deps.env),
    ...(environment ? [environment] : []),
    ...(publishMode ? [publishMode] : []),
    ...(autoPublish ? [autoPublish] : []),
    ...(instagram ? [instagram] : []),
    ...(mercadoLibre ? [mercadoLibre] : []),
    ...(ufSource ? [ufSource] : []),
    ...(llmKey ? [llmKey] : []),
    ...(anthropicModel ? [anthropicModel] : []),
    ...services.items,
    await checkFfmpegTool(deps.run, "ffmpeg", ffmpegPath),
    await checkFfmpegTool(deps.run, "ffprobe", ffprobePath),
    checkChromium(deps.chromium),
    await checkPgDump(
      deps.run,
      () => findPgDump(pgBinDir),
      services.report?.database?.serverVersion,
    ),
    ...(backup ? [backup] : []),
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
    .description(
      "Revisa el entorno: .env, API, base, almacenamiento, cola y herramientas (con un servidor remoto, el servidor)",
    )
    .action(async () => {
      const server = ctx.server();
      const remote = server.ok && server.target.remote;
      const report = await runDoctor({
        server,
        nodeVersion: process.version,
        env: loadEnvironment(),
        fetchHealth: createHealthFetcher(ctx.api()),
        run: runCommand,
        // Con un servidor remoto, Chromium es del servidor: no se busca en el Mac.
        chromium: remote ? null : await chromiumStatus().catch(() => null),
        processEnv: process.env,
      });
      ctx.print(renderDoctor(report, ctx.colors));
      process.exitCode = report.exitCode;
    });
}
