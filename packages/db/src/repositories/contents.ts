import {
  AppError,
  type Content,
  type ContentRepository,
  contentSchema,
  LANGUAGES,
  PLATFORMS,
  pickContentChanges,
  subjectFieldsOf,
  toSubject,
} from "@agentsales/core";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { withDbErrors } from "../errors.js";
import { contents } from "../schema.js";

/** Fila → entidad. Una fila corrupta es `CONTENT_ROW_INVALID` (no reintentable). */
function toContent(row: typeof contents.$inferSelect): Content {
  const parsed = contentSchema.safeParse({
    id: row.id,
    // Exactamente uno de `listing_id` y `post_id` (ADR-0029); si no, la fila no valida.
    ...subjectFieldsOf(row),
    contentRunId: row.contentRunId,
    platform: row.platform,
    // Texto en la base: se valida con `LANGUAGES` al leer.
    language: row.language,
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

/** El orden de `listCurrent`: el de `PLATFORMS` y, dentro de cada red, el de `LANGUAGES`. */
const currentOrder = (a: Content, b: Content) =>
  PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform) ||
  LANGUAGES.indexOf(a.language) - LANGUAGES.indexOf(b.language);

/** `ContentRepository` sobre Drizzle (node-postgres en las apps, PGlite en los tests). */
export function createContentRepository(db: SchemaDatabase): ContentRepository {
  return {
    listCurrentMany(listingIds) {
      return withDbErrors(async () => {
        if (listingIds.length === 0) return [];
        // El más reciente de cada aviso y canal, en una sola consulta (deuda de F6).
        const rows = await db
          .selectDistinctOn([contents.listingId, contents.platform])
          .from(contents)
          .where(inArray(contents.listingId, [...new Set(listingIds)]))
          .orderBy(
            asc(contents.listingId),
            asc(contents.platform),
            desc(contents.createdAt),
            desc(contents.id),
          );
        return rows.map(toContent);
      });
    },

    listCurrent(ref) {
      const subject = toSubject(ref);
      return withDbErrors(async () => {
        // El más reciente de cada canal e idioma (`DISTINCT ON`). El índice (aviso o post,
        // platform, created_at) acota las filas; con pocas filas por canal, el orden descendente
        // no importa. Los textos de un aviso son todos `es`: uno por canal, como antes de F9.
        const rows = await db
          .selectDistinctOn([contents.platform, contents.language])
          .from(contents)
          .where(
            subject.kind === "listing"
              ? eq(contents.listingId, subject.id)
              : eq(contents.postId, subject.id),
          )
          .orderBy(
            asc(contents.platform),
            asc(contents.language),
            desc(contents.createdAt),
            desc(contents.id),
          );
        return rows.map(toContent).sort(currentOrder);
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
