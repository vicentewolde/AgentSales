import type { HealthFetcher } from "./api-client.js";
import {
  type CheckItem,
  checkChromium,
  checkClaude,
  checkEnv,
  checkFfmpeg,
  checkNode,
  checkPublishMode,
  checkServices,
  type EnvResult,
  type Level,
  type RunCommand,
} from "./checks.js";
import type { Colors } from "./colors.js";

export type DoctorDeps = {
  nodeVersion: string;
  env: EnvResult;
  fetchHealth: HealthFetcher;
  run: RunCommand;
  chromiumDir: string | null;
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
  const items: CheckItem[] = [
    checkNode(deps.nodeVersion),
    checkEnv(deps.env),
    ...(publishMode ? [publishMode] : []),
    ...services.items,
    await checkFfmpeg(deps.run, ffmpegPath),
    checkChromium(deps.chromiumDir),
    await checkClaude(deps.run),
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
