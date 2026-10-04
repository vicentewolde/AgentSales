import type { ImportReport } from "./import-run.js";

/**
 * Cómo esperan una corrida (una carga o una preparación de contenido) la CLI y el panel (spec F1
 * §4.4 y §4.7, F2 §4.9): consultan cada 2 s, avisan a los 20 s si sigue en cola, y dejan de
 * consultar a las 2 h o tras 3 fallas seguidas, para no mantener Neon despierto con una corrida
 * atascada (ADR-0007). Era `IMPORT_WAIT` hasta F2-T13.
 */
export const RUN_WAIT: Readonly<{
  pollMs: number;
  queuedWarningMs: number;
  maxWaitMs: number;
  maxPollFailures: number;
}> = {
  pollMs: 2_000,
  queuedWarningMs: 20_000,
  maxWaitMs: 2 * 60 * 60 * 1000,
  /** Consultas seguidas que pueden fallar (API reiniciándose, Neon despertando) antes de parar. */
  maxPollFailures: 3,
};

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
