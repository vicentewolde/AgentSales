import {
  AppError,
  type Content,
  type ContentRepository,
  contentSchema,
  PLATFORMS,
} from "@agentsales/core";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { withDbErrors } from "../errors.js";
import { contents } from "../schema.js";

/** Fila → entidad. Una fila corrupta es `CONTENT_INVALID` (no reintentable). */
function toContent(row: typeof contents.$inferSelect): Content {
  const parsed = contentSchema.safeParse({
    id: row.id,
    listingId: row.listingId,
    contentRunId: row.contentRunId,
    platform: row.platform,
    title: row.title,
    body: row.body,
    hashtags: row.hashtags,
    status: row.status,
    llmProvider: row.llmProvider,
    llmModel: row.llmModel,
    promptVersion: row.promptVersion,
    rawOutput: row.rawOutput,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  if (!parsed.success) {
    throw new AppError("CONTENT_INVALID", `El contenido ${row.id} tiene datos inválidos`, {
      details: { id: row.id, issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

const platformOrder = (content: Content) => PLATFORMS.indexOf(content.platform);

/** `ContentRepository` sobre Drizzle (node-postgres en las apps, PGlite en los tests). */
export function createContentRepository(db: SchemaDatabase): ContentRepository {
  return {
    listCurrent(listingId) {
      return withDbErrors(async () => {
        // El más reciente de cada canal (`DISTINCT ON`), con el índice (listing, platform, created_at).
        const rows = await db
          .selectDistinctOn([contents.platform])
          .from(contents)
          .where(eq(contents.listingId, listingId))
          .orderBy(asc(contents.platform), desc(contents.createdAt), desc(contents.id));
        return rows.map(toContent).sort((a, b) => platformOrder(a) - platformOrder(b));
      });
    },

    get(id) {
      return withDbErrors(async () => {
        const [row] = await db.select().from(contents).where(eq(contents.id, id));
        return row === undefined ? null : toContent(row);
      });
    },

    update(id, changes) {
      return withDbErrors(async () => {
        const set = Object.fromEntries(
          Object.entries(changes).filter(([, value]) => value !== undefined),
        );
        const [row] = await db
          .update(contents)
          // La hora de la base, explícita: así también cambia sin otros campos.
          .set({ ...set, updatedAt: sql`now()` })
          .where(eq(contents.id, id))
          .returning();
        if (row === undefined) {
          throw new AppError("CONTENT_NOT_FOUND", `No existe el contenido ${id}`);
        }
        return toContent(row);
      });
    },
  };
}
