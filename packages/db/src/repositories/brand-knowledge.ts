import {
  AppError,
  addLlmCall,
  type BrandKnowledge,
  type BrandKnowledgeRepository,
  brandKnowledgeSchema,
  type KnowledgeExample,
  type KnowledgeProposal,
  type KnowledgeProposalRepository,
  type KnowledgeRun,
  type KnowledgeUpdate,
  knowledgeExampleSchema,
  knowledgeProposalSchema,
  knowledgeRunSchema,
  knowledgeUpdateSchema,
  llmUsageSchema,
} from "@agentsales/core";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { isUniqueViolation, sqlStateOf, withDbErrors } from "../errors.js";
import {
  brandKnowledge,
  brandKnowledgeExamples,
  brandKnowledgeProposals,
  brandKnowledgeRuns,
  brandKnowledgeUpdates,
} from "../schema.js";

// El conocimiento de la marca sobre Drizzle (spec F9.7 B1 y B2, ADR-0043).

/** Una fila validada con su esquema de core; si no calza, `KNOWLEDGE_ROW_INVALID`. */
type Parser<T> = {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: unknown } };
};

function parsed<T>(schema: Parser<T>, row: unknown, what: string): T {
  const result = schema.safeParse(row);
  if (!result.success) {
    throw new AppError("KNOWLEDGE_ROW_INVALID", `${what} tiene datos inválidos`, {
      details: { issues: result.error.issues },
    });
  }
  return result.data;
}

const toKnowledge = (row: typeof brandKnowledge.$inferSelect): BrandKnowledge =>
  parsed(brandKnowledgeSchema, row, "El conocimiento de la marca");
const toExample = (row: typeof brandKnowledgeExamples.$inferSelect): KnowledgeExample =>
  parsed(knowledgeExampleSchema, row, "Un ejemplo de la marca");
const toUpdate = (row: typeof brandKnowledgeUpdates.$inferSelect): KnowledgeUpdate =>
  parsed(knowledgeUpdateSchema, row, "Una novedad de la marca");
const toRun = (row: typeof brandKnowledgeRuns.$inferSelect): KnowledgeRun =>
  parsed(knowledgeRunSchema, row, "Una lectura de texto");
const toProposal = (row: typeof brandKnowledgeProposals.$inferSelect): KnowledgeProposal =>
  parsed(knowledgeProposalSchema, row, "Una propuesta");

/** Una FK que no existe (el corredor) es `KNOWLEDGE_REFERENCE_INVALID`. */
async function withReference<T>(brokerId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await withDbErrors(fn);
  } catch (error) {
    if (sqlStateOf(error) === "23503") {
      throw new AppError("KNOWLEDGE_REFERENCE_INVALID", "El corredor no existe", {
        details: { brokerId },
        cause: error,
      });
    }
    throw error;
  }
}

export function createBrandKnowledgeRepository(db: SchemaDatabase): BrandKnowledgeRepository {
  return {
    get(brokerId) {
      return withDbErrors(async () => {
        const [row] = await db
          .select()
          .from(brandKnowledge)
          .where(eq(brandKnowledge.brokerId, brokerId));
        return row === undefined ? null : toKnowledge(row);
      });
    },

    listExamples(brokerId) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(brandKnowledgeExamples)
          .where(eq(brandKnowledgeExamples.brokerId, brokerId))
          .orderBy(asc(brandKnowledgeExamples.sortOrder), asc(brandKnowledgeExamples.createdAt));
        return rows.map(toExample);
      });
    },

    save(brokerId, data) {
      return withReference(brokerId, () =>
        db.transaction(async (tx) => {
          const values = { stance: data.stance, tone: data.tone };
          const [row] = await tx
            .insert(brandKnowledge)
            .values({ brokerId, ...values })
            .onConflictDoUpdate({
              target: brandKnowledge.brokerId,
              set: { ...values, updatedAt: sql`now()` },
            })
            .returning();
          if (row === undefined) {
            throw new AppError("KNOWLEDGE_WRITE_FAILED", "No se guardó el conocimiento");
          }
          await tx
            .delete(brandKnowledgeExamples)
            .where(eq(brandKnowledgeExamples.brokerId, brokerId));
          const examples =
            data.examples.length === 0
              ? []
              : await tx
                  .insert(brandKnowledgeExamples)
                  .values(
                    data.examples.map((example, index) => ({
                      brokerId,
                      text: example.text,
                      note: example.note,
                      favorite: example.favorite,
                      sortOrder: index,
                    })),
                  )
                  .returning();
          return {
            knowledge: toKnowledge(row),
            examples: examples.sort((a, b) => a.sortOrder - b.sortOrder).map(toExample),
          };
        }),
      );
    },

    listUpdates(brokerId, options = {}) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(brandKnowledgeUpdates)
          .where(
            and(
              eq(brandKnowledgeUpdates.brokerId, brokerId),
              options.includeArchived === true
                ? undefined
                : isNull(brandKnowledgeUpdates.archivedAt),
              options.since === undefined
                ? undefined
                : gte(brandKnowledgeUpdates.date, options.since),
            ),
          )
          .orderBy(
            desc(brandKnowledgeUpdates.date),
            desc(brandKnowledgeUpdates.createdAt),
            desc(brandKnowledgeUpdates.id),
          )
          .limit(options.limit ?? 500);
        return rows.map(toUpdate);
      });
    },

    getUpdate(id) {
      return withDbErrors(async () => {
        const [row] = await db
          .select()
          .from(brandKnowledgeUpdates)
          .where(eq(brandKnowledgeUpdates.id, id));
        return row === undefined ? null : toUpdate(row);
      });
    },

    addUpdate(brokerId, update) {
      return withReference(brokerId, async () => {
        const [row] = await db
          .insert(brandKnowledgeUpdates)
          .values({
            brokerId,
            project: update.project,
            date: update.date,
            text: update.text,
            source: update.source,
          })
          .returning();
        if (row === undefined) {
          throw new AppError("KNOWLEDGE_WRITE_FAILED", "No se guardó la novedad");
        }
        return toUpdate(row);
      });
    },

    editUpdate(id, update) {
      return withDbErrors(async () => {
        const [row] = await db
          .update(brandKnowledgeUpdates)
          .set({ ...update, updatedAt: sql`now()` })
          .where(eq(brandKnowledgeUpdates.id, id))
          .returning();
        return row === undefined ? null : toUpdate(row);
      });
    },

    archiveUpdate(id) {
      return withDbErrors(async () => {
        const [row] = await db
          .update(brandKnowledgeUpdates)
          .set({
            archivedAt: sql`coalesce(${brandKnowledgeUpdates.archivedAt}, now())`,
            updatedAt: sql`now()`,
          })
          .where(eq(brandKnowledgeUpdates.id, id))
          .returning();
        return row === undefined ? null : toUpdate(row);
      });
    },
  };
}

const isActiveRun = inArray(brandKnowledgeRuns.status, ["queued", "running"]);

export function createKnowledgeProposalRepository(db: SchemaDatabase): KnowledgeProposalRepository {
  return {
    async createRun(run) {
      try {
        return await withReference(run.brokerId, async () => {
          const [row] = await db
            .insert(brandKnowledgeRuns)
            .values({
              brokerId: run.brokerId,
              sourceText: run.sourceText,
              createdBy: run.createdBy,
            })
            .returning();
          if (row === undefined) {
            throw new AppError("KNOWLEDGE_WRITE_FAILED", "No se creó la lectura");
          }
          return toRun(row);
        });
      } catch (error) {
        if (isUniqueViolation(error, "brand_knowledge_runs_one_active_per_broker")) {
          throw new AppError(
            "KNOWLEDGE_RUN_CONFLICT",
            "Ya hay una lectura de texto en curso para esta marca",
            { details: { brokerId: run.brokerId }, cause: error },
          );
        }
        throw error;
      }
    },

    getRun(id) {
      return withDbErrors(async () => {
        const [row] = await db
          .select()
          .from(brandKnowledgeRuns)
          .where(eq(brandKnowledgeRuns.id, id));
        return row === undefined ? null : toRun(row);
      });
    },

    listRuns(brokerId, limit = 10) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(brandKnowledgeRuns)
          .where(eq(brandKnowledgeRuns.brokerId, brokerId))
          .orderBy(desc(brandKnowledgeRuns.createdAt), desc(brandKnowledgeRuns.id))
          .limit(limit);
        return rows.map(toRun);
      });
    },

    markRunning(id) {
      return withDbErrors(async () => {
        const updated = await db
          .update(brandKnowledgeRuns)
          .set({
            status: "running",
            startedAt: sql`coalesce(${brandKnowledgeRuns.startedAt}, now())`,
            updatedAt: sql`now()`,
          })
          .where(and(eq(brandKnowledgeRuns.id, id), isActiveRun))
          .returning({ id: brandKnowledgeRuns.id });
        return updated.length > 0;
      });
    },

    markSucceeded(id, result) {
      return withDbErrors(() =>
        db.transaction(async (tx) => {
          const [updated] = await tx
            .update(brandKnowledgeRuns)
            .set({
              status: "succeeded",
              warnings: [...result.warnings],
              finishedAt: sql`now()`,
              updatedAt: sql`now()`,
            })
            .where(and(eq(brandKnowledgeRuns.id, id), eq(brandKnowledgeRuns.status, "running")))
            .returning({ id: brandKnowledgeRuns.id, brokerId: brandKnowledgeRuns.brokerId });
          if (updated === undefined) return false;
          if (result.proposals.length > 0) {
            await tx.insert(brandKnowledgeProposals).values(
              result.proposals.map((proposal, position) => ({
                position,
                brokerId: updated.brokerId,
                runId: id,
                kind: proposal.kind,
                text: proposal.text,
                project: proposal.project,
                date: proposal.date,
              })),
            );
          }
          return true;
        }),
      );
    },

    markFailed(id, error) {
      return withDbErrors(async () => {
        const updated = await db
          .update(brandKnowledgeRuns)
          .set({ status: "failed", error, finishedAt: sql`now()`, updatedAt: sql`now()` })
          .where(and(eq(brandKnowledgeRuns.id, id), isActiveRun))
          .returning({ id: brandKnowledgeRuns.id });
        return updated.length > 0;
      });
    },

    addLlmUsage(id, call) {
      return withDbErrors(() =>
        db.transaction(async (tx) => {
          const [row] = await tx
            .select()
            .from(brandKnowledgeRuns)
            .where(eq(brandKnowledgeRuns.id, id))
            .for("update");
          if (row === undefined) {
            throw new AppError("KNOWLEDGE_RUN_NOT_FOUND", `No existe la lectura ${id}`);
          }
          const previous = row.llmUsage === null ? null : llmUsageSchema.parse(row.llmUsage);
          const [updated] = await tx
            .update(brandKnowledgeRuns)
            .set({ llmUsage: addLlmCall(previous, call) })
            .where(eq(brandKnowledgeRuns.id, id))
            .returning();
          if (updated === undefined) {
            throw new AppError("KNOWLEDGE_RUN_NOT_FOUND", `No existe la lectura ${id}`);
          }
          return toRun(updated);
        }),
      );
    },

    listProposals(brokerId, options = {}) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(brandKnowledgeProposals)
          .where(
            and(
              eq(brandKnowledgeProposals.brokerId, brokerId),
              options.status === undefined
                ? undefined
                : eq(brandKnowledgeProposals.status, options.status),
            ),
          )
          .orderBy(
            desc(brandKnowledgeProposals.createdAt),
            asc(brandKnowledgeProposals.position),
            asc(brandKnowledgeProposals.id),
          )
          .limit(options.limit ?? 100);
        return rows.map(toProposal);
      });
    },

    getProposal(id) {
      return withDbErrors(async () => {
        const [row] = await db
          .select()
          .from(brandKnowledgeProposals)
          .where(eq(brandKnowledgeProposals.id, id));
        return row === undefined ? null : toProposal(row);
      });
    },

    resolveProposal(id, status) {
      return withDbErrors(async () => {
        const updated = await db
          .update(brandKnowledgeProposals)
          .set({ status, updatedAt: sql`now()` })
          .where(
            and(eq(brandKnowledgeProposals.id, id), eq(brandKnowledgeProposals.status, "pending")),
          )
          .returning({ id: brandKnowledgeProposals.id });
        return updated.length > 0;
      });
    },
  };
}
