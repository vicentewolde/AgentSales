import {
  AppError,
  type ImportRun,
  type ImportRunRepository,
  importRunSchema,
} from "@agentsales/core";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { withDbErrors } from "../errors.js";
import { importRuns } from "../schema.js";

/**
 * Fila → entidad. `input`, `report` y `error` son jsonb que escribió otro proceso: se validan al
 * leerlos. Una fila corrupta es `IMPORT_RUN_INVALID` (no reintentable), con el detalle en `details`.
 */
function toImportRun(row: typeof importRuns.$inferSelect): ImportRun {
  const parsed = importRunSchema.safeParse({
    id: row.id,
    brokerId: row.brokerId,
    status: row.status,
    dryRun: row.dryRun,
    source: row.source,
    fileName: row.fileName,
    input: row.input,
    rowsTotal: row.rowsTotal,
    rowsCreated: row.rowsCreated,
    rowsUpdated: row.rowsUpdated,
    rowsSkipped: row.rowsSkipped,
    rowsFailed: row.rowsFailed,
    report: row.report,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  });
  if (!parsed.success) {
    throw new AppError("IMPORT_RUN_INVALID", `La carga ${row.id} tiene datos inválidos`, {
      details: { id: row.id, issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

const notFound = (id: string) => new AppError("IMPORT_RUN_NOT_FOUND", `No existe la carga ${id}`);

/** `ImportRunRepository` sobre Drizzle (node-postgres en las apps, PGlite en los tests). */
export function createImportRunRepository(db: SchemaDatabase): ImportRunRepository {
  return {
    create(run) {
      return withDbErrors(async () => {
        const [row] = await db
          .insert(importRuns)
          .values({
            ...(run.id === undefined ? {} : { id: run.id }),
            source: run.source,
            fileName: run.fileName,
            dryRun: run.dryRun,
            input: run.input,
          })
          .returning();
        if (row === undefined) throw new AppError("IMPORT_RUN_WRITE_FAILED", "No se creó la carga");
        return toImportRun(row);
      });
    },

    list(limit = 50) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(importRuns)
          .orderBy(desc(importRuns.createdAt), desc(importRuns.id))
          .limit(limit);
        return rows.map(toImportRun);
      });
    },

    get(id) {
      return withDbErrors(async () => {
        const [row] = await db.select().from(importRuns).where(eq(importRuns.id, id));
        return row === undefined ? null : toImportRun(row);
      });
    },

    recordListingsResult(id, { brokerId, counts, report }) {
      return withDbErrors(async () => {
        // No cambia `status` ni `finished_at`: eso es del job `import.run` (F1-T09).
        const updated = await db
          .update(importRuns)
          .set({ brokerId, ...counts, report })
          .where(eq(importRuns.id, id))
          .returning({ id: importRuns.id });
        if (updated.length === 0) throw notFound(id);
      });
    },

    markRunning(id) {
      return withDbErrors(async () => {
        const updated = await db
          .update(importRuns)
          // `started_at` es el del primer intento: un reintento no lo mueve.
          .set({ status: "running", startedAt: sql`coalesce(${importRuns.startedAt}, now())` })
          .where(and(eq(importRuns.id, id), inArray(importRuns.status, ["queued", "running"])))
          .returning({ id: importRuns.id });
        return updated.length > 0;
      });
    },

    markSucceeded(id) {
      return withDbErrors(async () => {
        const updated = await db
          .update(importRuns)
          .set({ status: "succeeded", finishedAt: sql`now()` })
          .where(and(eq(importRuns.id, id), eq(importRuns.status, "running")))
          .returning({ id: importRuns.id });
        return updated.length > 0;
      });
    },

    markFailed(id, error) {
      return withDbErrors(async () => {
        const updated = await db
          .update(importRuns)
          .set({ status: "failed", error, finishedAt: sql`now()` })
          .where(and(eq(importRuns.id, id), inArray(importRuns.status, ["queued", "running"])))
          .returning({ id: importRuns.id });
        return updated.length > 0;
      });
    },

    failAbandoned(startedBefore, error) {
      return withDbErrors(async () => {
        const closed = await db
          .update(importRuns)
          .set({ status: "failed", error, finishedAt: sql`now()` })
          .where(and(eq(importRuns.status, "running"), lt(importRuns.startedAt, startedBefore)))
          .returning({ id: importRuns.id });
        return closed.map((row) => row.id);
      });
    },

    recordMediaResult(id, report) {
      return withDbErrors(async () => {
        const updated = await db
          .update(importRuns)
          .set({ report })
          .where(eq(importRuns.id, id))
          .returning({ id: importRuns.id });
        if (updated.length === 0) throw notFound(id);
      });
    },
  };
}
