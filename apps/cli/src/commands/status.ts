import type { HealthReport } from "@agentsales/core";
import type { Command } from "commander";
import { apiHint, createHealthFetcher, type HealthFetcher } from "../api-client.js";
import type { Colors } from "../colors.js";
import type { CliContext } from "../context.js";

export type StatusResult = { text: string; exitCode: 0 | 1 };

/** `PUBLISH_MODE` destacado: rojo si es `live`, verde si es `dry-run`. */
export function renderPublishMode(mode: HealthReport["publishMode"], c: Colors): string {
  return mode === "live"
    ? c.bold(c.bgRed(c.white(" PUBLISH_MODE: LIVE — las publicaciones son reales ")))
    : c.bold(c.green("PUBLISH_MODE: dry-run (no se publica nada)"));
}

/**
 * `auto_publish` (spec F6 §4.10): en vivo y con corredores que lo tienen, en rojo (publica sin
 * revisión); en simulación, una nota. `null` si ningún corredor lo tiene (o la API no lo informa).
 */
export function renderAutoPublish(report: HealthReport, c: Colors): string | null {
  // En vivo, no saber (la base no respondió) también se dice: podría estar publicando solo.
  if (report.autoPublishBrokers === null && report.publishMode === "live") {
    return c.yellow("No se pudo saber si algún corredor tiene auto_publish (la base no respondió)");
  }
  const brokers = report.autoPublishBrokers ?? [];
  if (brokers.length === 0) return null;
  return report.publishMode === "live"
    ? c.bold(
        c.bgRed(c.white(` auto_publish EN VIVO: publica sin tu revisión (${brokers.join(", ")}) `)),
      )
    : c.dim(`auto_publish activado (en simulación): ${brokers.join(", ")}`);
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
  // Sin el detalle (sin sesión de administrador, spec F7 §4.3): solo el estado y el modo.
  const checks = Object.entries(report.checks ?? {}).map(([name, result]) => {
    const mark = result.ok ? c.green("✓") : c.red("✗");
    const detail = result.ok ? `${result.latencyMs} ms` : (result.error ?? "falló");
    return `  ${mark} ${name.padEnd(8)} ${detail}`;
  });
  return {
    text: [
      renderPublishMode(report.publishMode, c),
      ...[renderAutoPublish(report, c)].filter((line): line is string => line !== null),
      "",
      `Estado: ${ok ? c.green("ok") : c.yellow("degraded")}  ${c.dim(`(API ${report.version ?? "?"})`)}`,
      ...(report.checks === undefined
        ? [c.dim("  El detalle lo ve el administrador: agentsales login")]
        : checks),
    ].join("\n"),
    exitCode: ok ? 0 : 1,
  };
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("status")
    .description("Estado de la API (/health) y PUBLISH_MODE")
    .action(async () => {
      const result = await runStatus(createHealthFetcher(ctx.api()), ctx.colors);
      ctx.print(result.text);
      process.exitCode = result.exitCode;
    });
}
