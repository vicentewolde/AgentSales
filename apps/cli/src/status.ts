import type { HealthReport } from "@agentsales/api";
import type { HealthFetcher } from "./api-client.js";
import { apiHint } from "./checks.js";
import type { Colors } from "./colors.js";

export type StatusResult = { text: string; exitCode: 0 | 1 };

/** `PUBLISH_MODE` destacado: rojo si es `live`, verde si es `dry-run`. */
export function renderPublishMode(mode: HealthReport["publishMode"], c: Colors): string {
  return mode === "live"
    ? c.bold(c.bgRed(c.white(" PUBLISH_MODE: LIVE — las publicaciones son reales ")))
    : c.bold(c.green("PUBLISH_MODE: dry-run (no se publica nada)"));
}

/** Estado desde `/health`. Sale con 0 solo si todo está `ok`. */
export async function runStatus(fetchHealth: HealthFetcher, c: Colors): Promise<StatusResult> {
  let report: HealthReport;
  try {
    report = await fetchHealth();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      text: `${c.red("✗ La API no responde")}: ${reason}\n  ${c.dim(`→ ${apiHint(error)}`)}`,
      exitCode: 1,
    };
  }
  const ok = report.status === "ok";
  const checks = Object.entries(report.checks).map(([name, result]) => {
    const mark = result.ok ? c.green("✓") : c.red("✗");
    const detail = result.ok ? `${result.latencyMs} ms` : (result.error ?? "falló");
    return `  ${mark} ${name.padEnd(8)} ${detail}`;
  });
  return {
    text: [
      renderPublishMode(report.publishMode, c),
      "",
      `Estado: ${ok ? c.green("ok") : c.yellow("degraded")}  ${c.dim(`(API ${report.version})`)}`,
      ...checks,
    ].join("\n"),
    exitCode: ok ? 0 : 1,
  };
}
