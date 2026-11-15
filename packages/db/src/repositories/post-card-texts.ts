import {
  AppError,
  type PostCardText,
  type PostCardTextRepository,
  postCardTextSchema,
} from "@agentsales/core";
import { and, asc, eq } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { sqlStateOf, withDbErrors } from "../errors.js";
import { postCardTexts } from "../schema.js";

// Los textos de las láminas de un post (spec F9.7 B5, ADR-0043).

function toCardText(row: typeof postCardTexts.$inferSelect): PostCardText {
  const parsed = postCardTextSchema.safeParse(row);
  if (!parsed.success) {
    throw new AppError("CARD_TEXTS_ROW_INVALID", `Las láminas del post ${row.postId} no calzan`, {
      details: { postId: row.postId, issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

export function createPostCardTextRepository(db: SchemaDatabase): PostCardTextRepository {
  return {
    list(postId) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(postCardTexts)
          .where(eq(postCardTexts.postId, postId))
          .orderBy(asc(postCardTexts.language), asc(postCardTexts.position));
        return rows.map(toCardText);
      });
    },

    async replace(postId, language, texts, { fromAi }) {
      try {
        return await withDbErrors(() =>
          db.transaction(async (tx) => {
            const where = and(
              eq(postCardTexts.postId, postId),
              eq(postCardTexts.language, language),
            );
            const current = await tx.select().from(postCardTexts).where(where).for("update");
            if (fromAi && current.some((row) => row.approved)) return false;
            await tx.delete(postCardTexts).where(where);
            if (texts.length > 0) {
              await tx.insert(postCardTexts).values(
                texts.map((text, index) => ({
                  postId,
                  language,
                  position: index + 1,
                  role: text.role,
                  headline: text.headline,
                  subtitle: text.subtitle,
                  approved: !fromAi,
                })),
              );
            }
            return true;
          }),
        );
      } catch (error) {
        if (sqlStateOf(error) === "23503") {
          throw new AppError("CARD_TEXTS_REFERENCE_INVALID", "El post no existe", {
            details: { postId },
            cause: error,
          });
        }
        throw error;
      }
    },
  };
}
