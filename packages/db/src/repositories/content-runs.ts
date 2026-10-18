import {
  ACTIVE_CONTENT_RUN_STATUSES,
  AppError,
  addLlmCall,
  type ContentRun,
  type ContentRunRepository,
  checkNewContents,
  contentRunSchema,
  llmUsageSchema,
} from "@agentsales/core";
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { isUniqueViolation, withDbErrors } from "../errors.js";
import { contentRuns, contents, listings } from "../schema.js";

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
    llmUsage: row.llmUsage,
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

    listAutoPublishPending(finishedSince) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(contentRuns)
          .where(
            and(
              eq(contentRuns.status, "succeeded"),
              eq(contentRuns.texts, true),
              isNull(contentRuns.autoPublishDoneAt),
              gte(contentRuns.finishedAt, finishedSince),
            ),
          )
          .orderBy(asc(contentRuns.finishedAt), asc(contentRuns.id));
        return rows.map(toContentRun);
      });
    },

    markAutoPublishDone(id) {
      return withDbErrors(async () => {
        // Condicional: solo la primera llamada lo anota (un segundo worker recibe `false`).
        const updated = await db
          .update(contentRuns)
          .set({ autoPublishDoneAt: sql`now()` })
          .where(
            and(
              eq(contentRuns.id, id),
              eq(contentRuns.status, "succeeded"),
              isNull(contentRuns.autoPublishDoneAt),
            ),
          )
          .returning({ id: contentRuns.id });
        return updated.length > 0;
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

    addLlmUsage(id, call) {
      return withDbErrors(() =>
        db.transaction(async (tx) => {
          // La fila bloqueada: dos llamadas que vuelven a la vez suman las dos.
          const [row] = await tx
            .select()
            .from(contentRuns)
            .where(eq(contentRuns.id, id))
            .for("update");
          if (row === undefined) {
            throw new AppError("CONTENT_RUN_NOT_FOUND", `No existe la corrida de contenido ${id}`);
          }
          const previous = row.llmUsage === null ? null : llmUsageSchema.parse(row.llmUsage);
          const [updated] = await tx
            .update(contentRuns)
            .set({ llmUsage: addLlmCall(previous, call) })
            .where(eq(contentRuns.id, id))
            .returning();
          if (updated === undefined) {
            throw new AppError("CONTENT_RUN_NOT_FOUND", `No existe la corrida de contenido ${id}`);
          }
          return toContentRun(updated);
        }),
      );
    },

    sumLlmCost({ from, to, brokerId }) {
      return withDbErrors(async () => {
        const cost = sql<string>`coalesce(sum((${contentRuns.llmUsage}->>'costUsd')::numeric), 0)`;
        const rows = await db
          .select({ brokerId: listings.brokerId, costUsd: cost, runs: sql<number>`count(*)::int` })
          .from(contentRuns)
          .innerJoin(listings, eq(listings.id, contentRuns.listingId))
          .where(
            and(
              sql`${contentRuns.llmUsage} IS NOT NULL`,
              gte(contentRuns.createdAt, from),
              lt(contentRuns.createdAt, to),
              brokerId === undefined ? undefined : eq(listings.brokerId, brokerId),
            ),
          )
          .groupBy(listings.brokerId);
        return rows.map((row) => ({
          brokerId: row.brokerId,
          costUsd: Number(row.costUsd),
          runs: Number(row.runs),
        }));
      });
    },
  };
}
