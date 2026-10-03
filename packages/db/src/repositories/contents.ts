import {
  AppError,
  type Content,
  type ContentRepository,
  contentSchema,
  PLATFORMS,
  pickContentChanges,
} from "@agentsales/core";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { withDbErrors } from "../errors.js";
import { contents } from "../schema.js";

/** Fila → entidad. Una fila corrupta es `CONTENT_ROW_INVALID` (no reintentable). */
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
    throw new AppError("CONTENT_ROW_INVALID", `El contenido ${row.id} tiene datos inválidos`, {
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
        // El más reciente de cada canal (`DISTINCT ON`). El índice (listing, platform, created_at)
        // acota las filas del aviso; con pocas filas por canal, el orden descendente no importa.
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
        // Solo los campos que el puerto permite cambiar: `undefined` = no tocar; `null` borra el título.
        const set = pickContentChanges(changes);
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
