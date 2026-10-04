import type { ImportReport } from "./import-run.js";

/** Un error de la carga, por fila y columna; `rowNumber` es `null` para la hoja Corredor. */
export type ImportIssue = {
  rowNumber: number | null;
  externalRef: string | null;
  column: string;
  message: string;
};

/**
 * Los errores y las advertencias de un reporte, aplanados como los muestran la CLI y el panel: los
 * de la hoja Corredor primero y después los de cada fila, en orden.
 */
export function importReportIssues(report: ImportReport): {
  errors: ImportIssue[];
  warnings: string[];
} {
  return {
    errors: [
      ...(report.broker?.issues ?? []).map((issue) => ({
        rowNumber: null,
        externalRef: null,
        column: issue.column,
        message: issue.message,
      })),
      ...report.rows.flatMap((row) =>
        row.errors.map((issue) => ({
          rowNumber: row.rowNumber,
          externalRef: row.externalRef,
          column: issue.column,
          message: issue.message,
        })),
      ),
    ],
    warnings: [
      ...(report.broker?.warnings ?? []).map((warning) => `Corredor: ${warning}`),
      ...report.rows.flatMap((row) =>
        row.warnings.map(
          (warning) =>
            `Fila ${row.rowNumber}${row.externalRef ? ` (${row.externalRef})` : ""}: ${warning}`,
        ),
      ),
    ],
  };
}
