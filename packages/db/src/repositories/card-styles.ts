import {
  AppError,
  type BrandCardStyle,
  type CardStyleRepository,
  cardStyleSchema,
} from "@agentsales/core";
import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { sqlStateOf, withDbErrors } from "../errors.js";
import { brandCardStyles, posts } from "../schema.js";

// El estilo de las imágenes de una marca y el tema de cada post (spec F9.7 B4 y B6, ADR-0043).

function toStyle(row: typeof brandCardStyles.$inferSelect): BrandCardStyle {
  const parsed = cardStyleSchema.safeParse(row.style);
  if (!parsed.success) {
    throw new AppError(
      "CARD_STYLE_ROW_INVALID",
      `El estilo de imágenes de ${row.brokerId} tiene datos inválidos`,
      { details: { brokerId: row.brokerId, issues: parsed.error.issues } },
    );
  }
  return {
    brokerId: row.brokerId,
    style: parsed.data,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

export function createCardStyleRepository(db: SchemaDatabase): CardStyleRepository {
  return {
    get(brokerId) {
      return withDbErrors(async () => {
        const [row] = await db
          .select()
          .from(brandCardStyles)
          .where(eq(brandCardStyles.brokerId, brokerId));
        return row === undefined ? null : toStyle(row);
      });
    },

    async save(brokerId, style) {
      try {
        return await withDbErrors(async () => {
          const [row] = await db
            .insert(brandCardStyles)
            .values({ brokerId, style })
            .onConflictDoUpdate({
              target: brandCardStyles.brokerId,
              set: {
                style,
                version: sql`${brandCardStyles.version} + 1`,
                updatedAt: sql`now()`,
              },
            })
            .returning();
          if (row === undefined) {
            throw new AppError("CARD_STYLE_WRITE_FAILED", "No se guardó el estilo");
          }
          return toStyle(row);
        });
      } catch (error) {
        if (sqlStateOf(error) === "23503") {
          throw new AppError("CARD_STYLE_REFERENCE_INVALID", "El corredor no existe", {
            details: { brokerId },
            cause: error,
          });
        }
        throw error;
      }
    },

    assignTheme(postId, brokerId, themes) {
      return withDbErrors(() =>
        db.transaction(async (tx) => {
          const [post] = await tx
            .select({ cardTheme: posts.cardTheme })
            .from(posts)
            .where(eq(posts.id, postId))
            .for("update");
          if (post === undefined) {
            throw new AppError("POST_NOT_FOUND", `No existe el post ${postId}`);
          }
          if (post.cardTheme !== null) return post.cardTheme;
          const [used] = await tx
            .select({ n: count() })
            .from(posts)
            .where(and(eq(posts.brokerId, brokerId), isNotNull(posts.cardTheme)));
          const theme = themes <= 0 ? 0 : (used?.n ?? 0) % themes;
          await tx.update(posts).set({ cardTheme: theme }).where(eq(posts.id, postId));
          return theme;
        }),
      );
    },
  };
}
