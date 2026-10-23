import {
  AppError,
  type PostImageRun,
  type PostImageRunRepository,
  postImageRunActive,
  postImageRunSchema,
} from "@agentsales/core";
import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { isUniqueViolation, sqlStateOf, withDbErrors } from "../errors.js";
import { postImageRuns } from "../schema.js";

/** Fila → entidad: `request` y `error` son jsonb y se validan al leer. */
function toRun(row: typeof postImageRuns.$inferSelect): PostImageRun {
  const parsed = postImageRunSchema.safeParse(row);
  if (!parsed.success) {
    throw new AppError(
      "POST_IMAGE_RUN_ROW_INVALID",
      `El pedido de imágenes ${row.id} tiene datos inválidos`,
      { details: { id: row.id, issues: parsed.error.issues } },
    );
  }
  return parsed.data;
}

const isActive = inArray(postImageRuns.status, ["queued", "running"]);

/** `PostImageRunRepository` sobre Drizzle (F9.5-T25, ADR-0038). */
export function createPostImageRunRepository(db: SchemaDatabase): PostImageRunRepository {
  return {
    async create(input) {
      try {
        return await withDbErrors(async () => {
          const [row] = await db
            .insert(postImageRuns)
            .values({
              postId: input.postId,
              brokerId: input.brokerId,
              source: input.source,
              request: input.request,
              createdBy: input.createdBy,
            })
            .returning();
          if (row === undefined) {
            throw new AppError("POST_IMAGE_RUN_WRITE_FAILED", "No se creó el pedido de imágenes");
          }
          return toRun(row);
        });
      } catch (error) {
        if (isUniqueViolation(error, "post_image_runs_one_active_per_post")) {
          const [active] = await db
            .select({ id: postImageRuns.id })
            .from(postImageRuns)
            .where(and(eq(postImageRuns.postId, input.postId), isActive));
          throw postImageRunActive(input.postId, active?.id ?? null);
        }
        if (sqlStateOf(error) === "23503") {
          throw new AppError(
            "POST_IMAGE_RUN_REFERENCE_INVALID",
            "El post, la marca o el usuario del pedido no existe",
            { details: { postId: input.postId }, cause: error },
          );
        }
        throw error;
      }
    },

    get(id) {
      return withDbErrors(async () => {
        const [row] = await db.select().from(postImageRuns).where(eq(postImageRuns.id, id));
        return row === undefined ? null : toRun(row);
      });
    },

    listByPost(postId, limit) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(postImageRuns)
          .where(eq(postImageRuns.postId, postId))
          .orderBy(desc(postImageRuns.createdAt), desc(postImageRuns.id))
          .limit(limit);
        return rows.map(toRun);
      });
    },

    markRunning(id) {
      return withDbErrors(async () => {
        const updated = await db
          .update(postImageRuns)
          .set({
            status: "running",
            startedAt: sql`coalesce(${postImageRuns.startedAt}, now())`,
            updatedAt: sql`now()`,
          })
          .where(and(eq(postImageRuns.id, id), isActive))
          .returning({ id: postImageRuns.id });
        return updated.length > 0;
      });
    },

    markSucceeded(id, mediaIds) {
      return withDbErrors(async () => {
        const updated = await db
          .update(postImageRuns)
          .set({
            status: "succeeded",
            mediaIds: [...mediaIds],
            finishedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(and(eq(postImageRuns.id, id), eq(postImageRuns.status, "running")))
          .returning({ id: postImageRuns.id });
        return updated.length > 0;
      });
    },

    markFailed(id, error) {
      return withDbErrors(async () => {
        const updated = await db
          .update(postImageRuns)
          .set({ status: "failed", error, finishedAt: sql`now()`, updatedAt: sql`now()` })
          .where(and(eq(postImageRuns.id, id), isActive))
          .returning({ id: postImageRuns.id });
        return updated.length > 0;
      });
    },

    recordCost(id, cost) {
      return withDbErrors(async () => {
        // Un reintento que vuelve a llamar a la IA suma su costo (se cobró dos veces).
        await db
          .update(postImageRuns)
          .set({
            costUsd: sql`coalesce(${postImageRuns.costUsd}, 0) + ${cost.costUsd}`,
            model: cost.model,
            updatedAt: sql`now()`,
          })
          .where(eq(postImageRuns.id, id));
      });
    },

    sumImageCost({ from, to, brokerId }) {
      return withDbErrors(async () => {
        const rows = await db
          .select({
            brokerId: postImageRuns.brokerId,
            costUsd: sql<string>`coalesce(sum(${postImageRuns.costUsd}), 0)`,
            images: sql<number>`count(*)::int`,
          })
          .from(postImageRuns)
          .where(
            and(
              isNotNull(postImageRuns.costUsd),
              gte(postImageRuns.createdAt, from),
              lt(postImageRuns.createdAt, to),
              brokerId === undefined ? undefined : eq(postImageRuns.brokerId, brokerId),
            ),
          )
          .groupBy(postImageRuns.brokerId);
        return rows.map((row) => ({
          brokerId: row.brokerId,
          costUsd: Number(row.costUsd),
          images: row.images,
        }));
      });
    },
  };
}
