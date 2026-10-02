import type { ImportRunView } from "@agentsales/api/contracts";
import { IMPORT_RUN_STATUS_TEXT, type ImportBrokerOutcome } from "@agentsales/core";
import type { Colors } from "../colors.js";
import { formatDateTime, renderTable } from "../output.js";

const BROKER_OUTCOME_TEXT: Readonly<Record<ImportBrokerOutcome, string>> = {
  created: "creado",
  updated: "actualizado",
  unchanged: "sin cambios",
  existing: "ya existía",
  invalid: "con errores",
};

/** Estado con color: verde si terminó, rojo si falló, amarillo mientras corre. */
export function paintStatus(run: Pick<ImportRunView, "status" | "dryRun">, c: Colors): string {
  const text = IMPORT_RUN_STATUS_TEXT[run.status] + (run.dryRun ? " (simulación)" : "");
  if (run.status === "succeeded") return c.green(text);
  if (run.status === "failed") return c.red(text);
  return c.yellow(text);
}

/** Sale con 1 si la carga falló o alguna fila quedó con errores. */
export const exitCodeOf = (run: ImportRunView): 0 | 1 =>
  run.status === "failed" || run.rowsFailed > 0 ? 1 : 0;

/**
 * Resumen de una carga (spec F1 §4.4): estado, corredor, propiedades y medios, y después la tabla
 * de errores por fila y columna y las advertencias. Lo usan `import` al terminar e `imports <id>`.
 */
export function renderImportRun(run: ImportRunView, c: Colors): string {
  const { report } = run;
  const lines = [
    `${c.bold(`Carga ${run.id}`)}  ${paintStatus(run, c)}`,
    `  Archivo: ${run.input.xlsxFile}${run.input.mediaFile ? ` · medios: ${run.input.mediaFile}` : ""}`,
    `  Creada: ${formatDateTime(run.createdAt)}`,
  ];
  if (run.dryRun) {
    lines.push(`  ${c.yellow("Simulación (--dry-run): muestra lo que pasaría, sin guardar nada")}`);
  }
  if (run.error !== null) {
    lines.push(`  ${c.red(`Error: ${run.error.code}: ${run.error.message}`)}`);
  }
  if (report?.broker) {
    lines.push(
      `  Corredor: ${report.broker.slug ?? "—"} (${BROKER_OUTCOME_TEXT[report.broker.outcome]})`,
    );
  }
  if (report !== null) {
    lines.push(
      `  Propiedades: creadas ${run.rowsCreated} · actualizadas ${run.rowsUpdated} · ` +
        `sin cambios ${run.rowsSkipped} · con error ${run.rowsFailed}`,
    );
    // `media` falta si la carga no llegó a la ingesta, o en reportes anteriores a F1-T07.
    lines.push(
      report.media
        ? `  Medios: subidos ${report.media.filesUploaded} · ya estaban ${report.media.filesExisting} · ` +
            `omitidos ${report.media.filesSkipped} · con error ${report.media.filesFailed}`
        : "  Medios: —",
    );
  }
  if (report === null) return lines.join("\n");

  const headers = report.headers;
  if (headers !== null) {
    if (headers.missing.length > 0) {
      lines.push(`  ${c.red(`Faltan columnas: ${headers.missing.join(", ")}`)}`);
    }
    if (headers.unknown.length > 0) {
      lines.push(
        `  ${c.yellow(`Columnas desconocidas (se guardan aparte): ${headers.unknown.join(", ")}`)}`,
      );
    }
    if (headers.duplicated.length > 0) {
      lines.push(`  ${c.yellow(`Columnas repetidas: ${headers.duplicated.join(", ")}`)}`);
    }
  }

  const errors = [
    ...(report.broker?.issues ?? []).map((issue) => ["Corredor", "—", issue.column, issue.message]),
    ...report.rows.flatMap((row) =>
      row.errors.map((issue) => [
        String(row.rowNumber),
        row.externalRef ?? "—",
        issue.column,
        issue.message,
      ]),
    ),
  ];
  if (errors.length > 0) {
    lines.push(
      "",
      c.red(c.bold(`Errores (${errors.length})`)),
      renderTable(["Fila", "Propiedad", "Columna", "Motivo"], errors, c),
    );
  }

  const warnings = [
    ...(report.broker?.warnings ?? []).map((warning) => `Corredor: ${warning}`),
    ...report.rows.flatMap((row) =>
      row.warnings.map(
        (warning) =>
          `Fila ${row.rowNumber}${row.externalRef ? ` (${row.externalRef})` : ""}: ${warning}`,
      ),
    ),
  ];
  if (warnings.length > 0) {
    lines.push(
      "",
      c.yellow(c.bold(`Advertencias (${warnings.length})`)),
      ...warnings.map((w) => `  ${w}`),
    );
  }
  return lines.join("\n");
}
