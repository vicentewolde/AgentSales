import {
  brokersLiveNow,
  type HealthReport,
  splitAutoPublish,
  workerStatusText,
} from "@agentsales/core";
import type { Command } from "commander";
import { apiHint, createHealthFetcher, type HealthFetcher } from "../api-client.js";
import type { Colors } from "../colors.js";
import type { CliContext } from "../context.js";
import { describeServer, type ServerTarget } from "../server.js";

export type StatusResult = { text: string; exitCode: 0 | 1 };

/**
 * `PUBLISH_MODE` (el del servidor) destacado: rojo si es `live`, verde si es `dry-run`. Desde
 * F9.5-T22 (ADR-0036) `live` solo **permite**: publican de verdad las marcas encendidas.
 */
export function renderPublishMode(mode: HealthReport["publishMode"], c: Colors): string {
  return mode === "live"
    ? c.bold(c.bgRed(c.white(" PUBLISH_MODE: LIVE — el servidor permite publicar de verdad ")))
    : c.bold(c.green("PUBLISH_MODE: dry-run (no se publica nada)"));
}

/**
 * Las marcas con el modo en vivo encendido (F9.5-T22, ADR-0036): en rojo las que publican de verdad
 * (servidor en `live`); en simulación, una nota. `null` si el reporte no trae la lista (sin sesión
 * de administrador o una API anterior).
 */
export function renderLiveBrokers(report: HealthReport, c: Colors): string | null {
  if (report.liveBrokers === undefined) return null;
  if (report.liveBrokers === null) {
    return c.yellow("No se pudo saber qué marcas están en vivo (la base no respondió)");
  }
  const live = brokersLiveNow(report) ?? [];
  if (live.length > 0) {
    return c.bold(c.bgRed(c.white(` EN VIVO publican de verdad: ${live.join(", ")} `)));
  }
  return report.liveBrokers.length === 0
    ? c.dim("Ninguna marca está en vivo: todo sale en simulación")
    : c.dim(
        `Marcas encendidas en vivo (siguen en simulación mientras el servidor esté en dry-run): ${report.liveBrokers.join(", ")}`,
      );
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
  const { live, simulated } = splitAutoPublish(report);
  if (live.length > 0) {
    return c.bold(
      c.bgRed(c.white(` auto_publish EN VIVO: publica sin tu revisión (${live.join(", ")}) `)),
    );
  }
  return simulated.length === 0
    ? null
    : c.dim(`auto_publish activado (en simulación): ${simulated.join(", ")}`);
}

/**
 * Estado desde `/health`. Sale con 0 solo si todo está `ok`. Con un servidor remoto (spec F8 §4.5),
 * dice cuál es.
 */
export async function runStatus(
  fetchHealth: HealthFetcher,
  c: Colors,
  server?: ServerTarget,
): Promise<StatusResult> {
  const serverLine = server?.remote ? [c.dim(`Servidor: ${describeServer(server)}`)] : [];
  let report: HealthReport;
  try {
    report = await fetchHealth();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      text: [
        ...serverLine,
        `${c.red("✗ La API no responde")}: ${reason}`,
        `  ${c.dim(`→ ${apiHint(error)}`)}`,
      ].join("\n"),
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
  const environment = report.environment === undefined ? "" : ` · ${report.environment}`;
  return {
    text: [
      ...serverLine,
      renderPublishMode(report.publishMode, c),
      ...[renderLiveBrokers(report, c), renderAutoPublish(report, c)].filter(
        (line): line is string => line !== null,
      ),
      "",
      `Estado: ${ok ? c.green("ok") : c.yellow("degraded")}  ${c.dim(`(API ${report.version ?? "?"}${environment})`)}`,
      ...(report.checks === undefined
        ? [c.dim("  El detalle lo ve el administrador: agentsales login")]
        : checks),
      // El worker según su latido (F8-T12).
      ...(report.worker === undefined
        ? []
        : [
            `  ${report.worker?.running ? c.green("✓") : c.yellow("⚠")} ${"worker".padEnd(8)} ${workerStatusText(report.worker)}`,
          ]),
    ].join("\n"),
    exitCode: ok ? 0 : 1,
  };
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("status")
    .description("Estado de la API (/health), el PUBLISH_MODE del servidor y las marcas en vivo")
    .action(async () => {
      const resolved = ctx.server();
      const result = await runStatus(
        createHealthFetcher(ctx.api()),
        ctx.colors,
        resolved.ok ? resolved.target : undefined,
      );
      ctx.print(result.text);
      process.exitCode = result.exitCode;
    });
}
