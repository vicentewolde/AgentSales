import { z } from "zod";
import { IMPORT_RUN_STATUSES, LISTING_SOURCES } from "./enums.js";
import { fieldIssueSchema } from "./listing-validator/index.js";

/** Resultado de una fila de la hoja Propiedades. `ignored`: fila `EJEMPLO` o `Borrador`. */
export const IMPORT_ROW_OUTCOMES = ["created", "updated", "skipped", "failed", "ignored"] as const;
export type ImportRowOutcome = (typeof IMPORT_ROW_OUTCOMES)[number];

/**
 * Resultado del corredor. `existing`: se usó uno ya creado (`--broker` sin hoja Corredor);
 * `invalid`: la hoja tiene errores y el run falla con `BROKER_INVALID`.
 */
export const IMPORT_BROKER_OUTCOMES = [
  "created",
  "updated",
  "unchanged",
  "existing",
  "invalid",
] as const;
export type ImportBrokerOutcome = (typeof IMPORT_BROKER_OUTCOMES)[number];

/**
 * Reporte de una carga (`import_runs.report`, ADR-0011): viaja por HTTP y lo muestran la CLI y el
 * panel. Con `dry_run`, los resultados son los que **habría** tenido la carga.
 */
export const importReportSchema = z.object({
  headers: z.object({
    unknown: z.array(z.string()),
    missing: z.array(z.string()),
    duplicated: z.array(z.string()),
  }),
  broker: z
    .object({
      slug: z.string().nullable(),
      outcome: z.enum(IMPORT_BROKER_OUTCOMES),
      issues: z.array(fieldIssueSchema),
      warnings: z.array(z.string()),
    })
    .nullable(),
  rows: z.array(
    z.object({
      rowNumber: z.number().int(),
      externalRef: z.string().nullable(),
      outcome: z.enum(IMPORT_ROW_OUTCOMES),
      errors: z.array(fieldIssueSchema),
    }),
  ),
});
export type ImportReport = z.infer<typeof importReportSchema>;

/** Contadores de `import_runs`. `rowsTotal` no cuenta las filas `ignored`. */
export type ImportCounts = {
  rowsTotal: number;
  rowsCreated: number;
  rowsUpdated: number;
  rowsSkipped: number;
  rowsFailed: number;
};

/** Carga (`import_runs`): la entidad que devuelve el repositorio. */
export const importRunSchema = z.object({
  id: z.string(),
  brokerId: z.string().nullable(),
  status: z.enum(IMPORT_RUN_STATUSES),
  dryRun: z.boolean(),
  source: z.enum(LISTING_SOURCES),
  fileName: z.string(),
  rowsTotal: z.number().int(),
  rowsCreated: z.number().int(),
  rowsUpdated: z.number().int(),
  rowsSkipped: z.number().int(),
  rowsFailed: z.number().int(),
  /** `null` hasta que `importListings` registra su resultado. */
  report: importReportSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  createdAt: z.date(),
});
export type ImportRun = z.infer<typeof importRunSchema>;
