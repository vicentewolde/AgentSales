import {
  ACTIVE_CONTENT_RUN_STATUSES,
  AppError,
  type ContentRun,
  type ContentRunRepository,
  checkNewContents,
  contentRunSchema,
} from "@agentsales/core";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { isUniqueViolation, withDbErrors } from "../errors.js";
import { contentRuns, contents } from "../schema.js";

const ONE_ACTIVE_PER_LISTING = "content_runs_one_active_per_listing";
const RUN_PLATFORM_UNIQUE = "contents_run_platform_unique";

/**
 * Fila → entidad. `stage`, `report` y `error` los escribió otro proceso: se validan al leerlos.
 * Una fila corrupta es `CONTENT_RUN_ROW_INVALID` (no reintentable), con el detalle en `details`.
 */
function toContentRun(row: typeof contentRuns.$inferSelect): ContentRun {
  const parsed = contentRunSchema.safeParse({
    id: row.id,
    listingId: row.listingId,
    status: row.status,
    texts: row.texts,
    stage: row.stage,
    report: row.report,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  });
  if (!parsed.success) {
    throw new AppError(
      "CONTENT_RUN_ROW_INVALID",
      `La corrida de contenido ${row.id} tiene datos inválidos`,
      {
        details: { id: row.id, issues: parsed.error.issues },
      },
    );
  }
  return parsed.data;
}

const isActive = inArray(contentRuns.status, [...ACTIVE_CONTENT_RUN_STATUSES]);

/** `ContentRunRepository` sobre Drizzle (node-postgres en las apps, PGlite en los tests). */
export function createContentRunRepository(db: SchemaDatabase): ContentRunRepository {
  return {
    async create(run) {
      try {
        return await withDbErrors(async () => {
          const [row] = await db
            .insert(contentRuns)
            .values({ listingId: run.listingId, texts: run.texts })
            .returning();
          if (row === undefined) {
            throw new AppError("CONTENT_RUN_WRITE_FAILED", "No se creó la corrida de contenido");
          }
          return toContentRun(row);
        });
      } catch (error) {
        // Otra petición ganó la carrera: quien llama busca la activa con `findActive`.
        if (isUniqueViolation(error, ONE_ACTIVE_PER_LISTING)) {
          throw new AppError(
            "CONTENT_RUN_CONFLICT",
            `El aviso ${run.listingId} ya tiene una corrida de contenido en curso`,
            { retriable: true, cause: error },
          );
        }
        throw error;
      }
    },

    get(id) {
      return withDbErrors(async () => {
        const [row] = await db.select().from(contentRuns).where(eq(contentRuns.id, id));
        return row === undefined ? null : toContentRun(row);
      });
    },

    findActive(listingId) {
      return withDbErrors(async () => {
        const [row] = await db
          .select()
          .from(contentRuns)
          .where(and(eq(contentRuns.listingId, listingId), isActive));
        return row === undefined ? null : toContentRun(row);
      });
    },

    latest(listingId) {
      return withDbErrors(async () => {
        const [row] = await db
          .select()
          .from(contentRuns)
          .where(eq(contentRuns.listingId, listingId))
          .orderBy(desc(contentRuns.createdAt), desc(contentRuns.id))
          .limit(1);
        return row === undefined ? null : toContentRun(row);
      });
    },

    listQueued() {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(contentRuns)
          .where(eq(contentRuns.status, "queued"))
          .orderBy(asc(contentRuns.createdAt), asc(contentRuns.id));
        return rows.map(toContentRun);
      });
    },

    markRunning(id) {
      return withDbErrors(async () => {
        const updated = await db
          .update(contentRuns)
          // `started_at` es el del primer intento: un reintento no lo mueve.
          .set({ status: "running", startedAt: sql`coalesce(${contentRuns.startedAt}, now())` })
          .where(and(eq(contentRuns.id, id), isActive))
          .returning({ id: contentRuns.id });
        return updated.length > 0;
      });
    },

    setStage(id, stage) {
      return withDbErrors(async () => {
        const updated = await db
          .update(contentRuns)
          .set({ stage })
          .where(and(eq(contentRuns.id, id), eq(contentRuns.status, "running")))
          .returning({ id: contentRuns.id });
        return updated.length > 0;
      });
    },

    async markSucceeded(id, { report, contents: rows }) {
      checkNewContents(rows);
      try {
        return await withDbErrors(() =>
          db.transaction(async (tx) => {
            const [run] = await tx
              .update(contentRuns)
              .set({ status: "succeeded", report, finishedAt: sql`now()` })
              .where(and(eq(contentRuns.id, id), eq(contentRuns.status, "running")))
              .returning({ listingId: contentRuns.listingId });
            if (run === undefined) return false;
            if (rows.length > 0) {
              await tx.insert(contents).values(
                rows.map((row) => ({
                  ...row,
                  listingId: run.listingId,
                  contentRunId: id,
                  // jsonb NOT NULL: una salida ausente se guarda como `null` de JSON. Drizzle
                  // convierte el `null` de JavaScript en NULL de SQL, así que va explícito.
                  rawOutput: row.rawOutput ?? sql`'null'::jsonb`,
                })),
              );
            }
            return true;
          }),
        );
      } catch (error) {
        // Un canal que ya tenía fila: la transacción se deshizo completa, y el intento termina
        // como `skipped` (spec F2 §4.4).
        if (isUniqueViolation(error, RUN_PLATFORM_UNIQUE)) return false;
        throw error;
      }
    },

    markFailed(id, error, report) {
      return withDbErrors(async () => {
        const updated = await db
          .update(contentRuns)
          .set({
            status: "failed",
            error,
            ...(report === undefined ? {} : { report }),
            finishedAt: sql`now()`,
          })
          .where(and(eq(contentRuns.id, id), isActive))
          .returning({ id: contentRuns.id });
        return updated.length > 0;
      });
    },

    failAbandoned(startedBefore, error) {
      return withDbErrors(async () => {
        const closed = await db
          .update(contentRuns)
          .set({ status: "failed", error, finishedAt: sql`now()` })
          .where(and(eq(contentRuns.status, "running"), lt(contentRuns.startedAt, startedBefore)))
          .returning({ id: contentRuns.id });
        return closed.map((row) => row.id);
      });
    },
  };
}
