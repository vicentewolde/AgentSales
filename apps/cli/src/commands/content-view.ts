import type {
  ContentRunView,
  ContentView,
  ListingContentResponse,
} from "@agentsales/api/contracts";
import {
  CONTENT_REEL_OUTCOME_TEXT,
  CONTENT_RUN_STATUS_TEXT,
  CONTENT_STATUS_TEXT,
  PLATFORM_TEXT,
} from "@agentsales/core";
import type { Colors } from "../colors.js";
import { formatDateTime } from "../output.js";

/** Estado con color: verde si terminó, rojo si falló, amarillo mientras corre. */
export function paintContentRunStatus(run: Pick<ContentRunView, "status">, c: Colors): string {
  const text = CONTENT_RUN_STATUS_TEXT[run.status];
  if (run.status === "succeeded") return c.green(text);
  if (run.status === "failed") return c.red(text);
  return c.yellow(text);
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * Resumen de una corrida (spec F2 §4.7): estado, error, medios, portada y ficha, reel, la llamada a
 * la IA y las advertencias. Lo usa `prepare` al terminar.
 */
export function renderContentRun(run: ContentRunView, c: Colors): string {
  const { report } = run;
  const lines = [
    `${c.bold(`Preparación ${run.id}`)}  ${paintContentRunStatus(run, c)}`,
    `  Pedida: ${formatDateTime(run.createdAt)}${run.texts ? "" : c.dim(" · sin textos (--no-texts)")}`,
  ];
  if (run.error !== null)
    lines.push(`  ${c.red(`Error: ${run.error.code}: ${run.error.message}`)}`);
  if (report === null) return lines.join("\n");
  if (report.media) {
    lines.push(
      `  Medios: procesados ${report.media.processed} · ya estaban ${report.media.existing} · ` +
        `ilegibles ${report.media.failed}`,
    );
  }
  if (report.renders) {
    lines.push(
      `  Portada y ficha: armadas ${report.renders.rendered} · sin cambios ${report.renders.existing}`,
    );
  }
  if (report.reel) lines.push(`  Reel: ${CONTENT_REEL_OUTCOME_TEXT[report.reel]}`);
  if (report.llm) {
    const seconds = Math.round(report.llm.durationMs / 1000);
    lines.push(
      `  Textos: ${report.llm.promptVersion} · ${plural(report.llm.attempts, "intento", "intentos")} · ${seconds} s`,
    );
  }
  if (report.warnings.length > 0) {
    lines.push("", c.bold(`Advertencias (${report.warnings.length})`));
    for (const warning of report.warnings) lines.push(`  ${c.yellow("⚠")} ${warning}`);
  }
  return lines.join("\n");
}

/** Los problemas de la revisión de un texto, uno por línea (errores en rojo). */
function renderChecks(content: ContentView, c: Colors, indent: string): string[] {
  if (content.checks.length === 0) return [`${indent}${c.green("✓ sin problemas")}`];
  return content.checks.map((check) =>
    check.severity === "error"
      ? `${indent}${c.red(`✗ ${check.code}: ${check.message}`)}`
      : `${indent}${c.yellow(`⚠ ${check.code}: ${check.message}`)}`,
  );
}

/** Cuántos errores y advertencias tiene un texto (`sin problemas` si ninguno). */
function checkCounts(content: ContentView): string {
  const errors = content.checks.filter((check) => check.severity === "error").length;
  const warnings = content.checks.length - errors;
  if (errors === 0 && warnings === 0) return "sin problemas";
  return [
    errors > 0 ? plural(errors, "error", "errores") : null,
    warnings > 0 ? plural(warnings, "advertencia", "advertencias") : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** La revisión editorial de cada canal, resumida (para el final de `prepare`). */
export function renderChecksSummary(contents: readonly ContentView[], c: Colors): string {
  const lines = [c.bold("Revisión editorial")];
  for (const content of contents) {
    const hasErrors = content.checks.some((check) => check.severity === "error");
    const counts = checkCounts(content);
    lines.push(
      `  ${PLATFORM_TEXT[content.platform]}: ${
        hasErrors ? c.red(counts) : content.checks.length > 0 ? c.yellow(counts) : c.green(counts)
      }`,
    );
    if (content.checks.length > 0) lines.push(...renderChecks(content, c, "    "));
  }
  return lines.join("\n");
}

/** Un texto completo: canal, estado, título, cuerpo, hashtags y revisión. */
export function renderContent(content: ContentView, c: Colors): string {
  const lines = [
    `${c.bold(PLATFORM_TEXT[content.platform])}  ${c.dim(
      `${CONTENT_STATUS_TEXT[content.status]} · ${content.promptVersion} · ${formatDateTime(content.updatedAt)}`,
    )}`,
  ];
  if (content.title !== null) lines.push(`  ${c.bold(content.title)}`);
  lines.push(...content.body.split("\n").map((line) => (line === "" ? "" : `  ${line}`)));
  if (content.hashtags.length > 0) lines.push("", `  ${content.hashtags.join(" ")}`);
  lines.push("", `  ${c.bold("Revisión:")}`, ...renderChecks(content, c, "    "));
  return lines.join("\n");
}

/** Los medios por canal y la última corrida, en una línea cada uno (cabecera de `content`). */
export function renderContentMedia(content: ListingContentResponse, c: Colors): string {
  const run = content.latestRun;
  return [
    `  Carrusel de Instagram: ${plural(content.carousel.length, "imagen", "imágenes")}` +
      ` · Fotos de Portal y Marketplace: ${content.photos.length}` +
      ` · Reel: ${content.reel === null ? "no" : "sí"}`,
    `  Última preparación: ${
      run === null
        ? "ninguna"
        : `${paintContentRunStatus(run, c)} (${formatDateTime(run.createdAt)})${
            run.error === null ? "" : ` · ${c.red(run.error.code)}`
          }`
    }`,
  ].join("\n");
}
