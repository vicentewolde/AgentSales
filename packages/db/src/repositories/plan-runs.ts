import {
  AppError,
  addLlmCall,
  llmUsageSchema,
  PLAN_RUNS_LIST_LIMIT,
  type PlanRun,
  type PlanRunRepository,
  planRunSchema,
} from "@agentsales/core";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { isUniqueViolation, sqlStateOf, withDbErrors } from "../errors.js";
import { planRuns, posts } from "../schema.js";
import { newPostValues, postReferenceInvalid } from "./posts.js";

/**
 * Fila → entidad. `request`, `report`, `error` y `llm_usage` son jsonb: se validan al leer. Una fila
 * que no calza es `PLAN_RUN_ROW_INVALID` (no reintentable).
 */
function toPlanRun(row: typeof planRuns.$inferSelect): PlanRun {
  const parsed = planRunSchema.safeParse(row);
  if (!parsed.success) {
    throw new AppError("PLAN_RUN_ROW_INVALID", `El plan ${row.id} tiene datos inválidos`, {
      details: { id: row.id, issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

const isActive = inArray(planRuns.status, ["queued", "running"]);

/** `PlanRunRepository` sobre Drizzle (ADR-0030); la lógica del plan es de core (F9-T20). */
export function createPlanRunRepository(db: SchemaDatabase): PlanRunRepository {
  return {
    async create(input) {
      try {
        return await withDbErrors(async () => {
          const [row] = await db
            .insert(planRuns)
            .values({
              brokerId: input.brokerId,
              periodStart: input.periodStart,
              periodEnd: input.periodEnd,
              request: input.request,
            })
            .returning();
          if (row === undefined) throw new AppError("PLAN_RUN_WRITE_FAILED", "No se creó el plan");
          return toPlanRun(row);
        });
      } catch (error) {
        // F9-T20: la marca ya tiene un plan en cola o corriendo (el índice único parcial).
        if (isUniqueViolation(error, "plan_runs_one_active_per_broker")) {
          throw new AppError("PLAN_RUN_CONFLICT", "La marca ya tiene un plan en curso", {
            details: { brokerId: input.brokerId },
            cause: error,
          });
        }
        if (sqlStateOf(error) === "23503") {
          throw new AppError("PLAN_RUN_REFERENCE_INVALID", "El corredor del plan no existe", {
            details: { brokerId: input.brokerId },
            cause: error,
          });
        }
        throw error;
      }
    },

    get(id) {
      return withDbErrors(async () => {
        const [row] = await db.select().from(planRuns).where(eq(planRuns.id, id));
        return row === undefined ? null : toPlanRun(row);
      });
    },

    listByBroker(brokerId, limit = PLAN_RUNS_LIST_LIMIT.default) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(planRuns)
          .where(eq(planRuns.brokerId, brokerId))
          .orderBy(desc(planRuns.createdAt), desc(planRuns.id))
          .limit(limit);
        return rows.map(toPlanRun);
      });
    },

    markRunning(id) {
      return withDbErrors(async () => {
        const updated = await db
          .update(planRuns)
          .set({
            status: "running",
            // `started_at` es el del primer intento: un reintento no lo mueve.
            startedAt: sql`coalesce(${planRuns.startedAt}, now())`,
            updatedAt: sql`now()`,
          })
          .where(and(eq(planRuns.id, id), isActive))
          .returning({ id: planRuns.id });
        return updated.length > 0;
      });
    },

    async markSucceeded(id, { report, promptVersion, ideas = [] }) {
      try {
        return await withDbErrors(() =>
          db.transaction(async (tx) => {
            const updated = await tx
              .update(planRuns)
              .set({
                status: "succeeded",
                // jsonb: un reporte ausente se guarda como `null` de JSON, no como NULL de SQL.
                report: report ?? sql`'null'::jsonb`,
                promptVersion,
                finishedAt: sql`now()`,
                updatedAt: sql`now()`,
              })
              .where(and(eq(planRuns.id, id), eq(planRuns.status, "running")))
              .returning({ id: planRuns.id });
            // Otro intento ya lo cerró: sin ideas nuevas (no se duplican).
            if (updated.length === 0) return false;
            if (ideas.length > 0) await tx.insert(posts).values(ideas.map(newPostValues));
            return true;
          }),
        );
      } catch (error) {
        if (sqlStateOf(error) === "23503") {
          throw postReferenceInvalid(ideas[0]?.brokerId ?? "", error);
        }
        throw error;
      }
    },

    listQueued() {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(planRuns)
          .where(eq(planRuns.status, "queued"))
          .orderBy(asc(planRuns.createdAt), asc(planRuns.id));
        return rows.map(toPlanRun);
      });
    },

    failAbandoned(startedBefore, error) {
      return withDbErrors(async () => {
        const closed = await db
          .update(planRuns)
          .set({ status: "failed", error, finishedAt: sql`now()`, updatedAt: sql`now()` })
          .where(and(eq(planRuns.status, "running"), lt(planRuns.startedAt, startedBefore)))
          .returning({ id: planRuns.id });
        return closed.map((row) => row.id);
      });
    },

    markFailed(id, error) {
      return withDbErrors(async () => {
        const updated = await db
          .update(planRuns)
          .set({ status: "failed", error, finishedAt: sql`now()`, updatedAt: sql`now()` })
          .where(and(eq(planRuns.id, id), isActive))
          .returning({ id: planRuns.id });
        return updated.length > 0;
      });
    },

    addLlmUsage(id, call) {
      return withDbErrors(() =>
        db.transaction(async (tx) => {
          // La fila bloqueada: dos llamadas que vuelven a la vez suman las dos.
          const [row] = await tx.select().from(planRuns).where(eq(planRuns.id, id)).for("update");
          if (row === undefined) {
            throw new AppError("PLAN_RUN_NOT_FOUND", `No existe el plan ${id}`);
          }
          const previous = row.llmUsage === null ? null : llmUsageSchema.parse(row.llmUsage);
          const [updated] = await tx
            .update(planRuns)
            .set({ llmUsage: addLlmCall(previous, call), updatedAt: sql`now()` })
            .where(eq(planRuns.id, id))
            .returning();
          if (updated === undefined) {
            throw new AppError("PLAN_RUN_NOT_FOUND", `No existe el plan ${id}`);
          }
          return toPlanRun(updated);
        }),
      );
    },
  };
}
