import {
  AppError,
  type EditorialProfile,
  type EditorialProfileRepository,
  editorialProfileSchema,
} from "@agentsales/core";
import { eq, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { sqlStateOf, withDbErrors } from "../errors.js";
import { editorialProfiles } from "../schema.js";

/**
 * Fila → entidad. Los idiomas son texto en la base: se validan con `LANGUAGES` al leer. Una fila
 * que no calza es `EDITORIAL_PROFILE_ROW_INVALID` (no reintentable).
 */
function toProfile(row: typeof editorialProfiles.$inferSelect): EditorialProfile {
  const parsed = editorialProfileSchema.safeParse(row);
  if (!parsed.success) {
    throw new AppError(
      "EDITORIAL_PROFILE_ROW_INVALID",
      `El perfil editorial del corredor ${row.brokerId} tiene datos inválidos`,
      { details: { brokerId: row.brokerId, issues: parsed.error.issues } },
    );
  }
  return parsed.data;
}

/** `EditorialProfileRepository` sobre Drizzle (spec F9 §4.3): uno por corredor. */
export function createEditorialProfileRepository(db: SchemaDatabase): EditorialProfileRepository {
  return {
    get(brokerId) {
      return withDbErrors(async () => {
        const [row] = await db
          .select()
          .from(editorialProfiles)
          .where(eq(editorialProfiles.brokerId, brokerId));
        return row === undefined ? null : toProfile(row);
      });
    },

    async upsert(brokerId, profile) {
      const values = {
        languages: [...profile.languages],
        audience: profile.audience,
        pillars: profile.pillars,
        facts: [...profile.facts],
        avoid: [...profile.avoid],
        cadence: profile.cadence,
        defaultHashtags: [...profile.defaultHashtags],
      };
      try {
        return await withDbErrors(async () => {
          const [row] = await db
            .insert(editorialProfiles)
            .values({ brokerId, ...values })
            .onConflictDoUpdate({
              target: editorialProfiles.brokerId,
              set: { ...values, updatedAt: sql`now()` },
            })
            .returning();
          if (row === undefined) {
            throw new AppError("EDITORIAL_PROFILE_WRITE_FAILED", "No se guardó el perfil");
          }
          return toProfile(row);
        });
      } catch (error) {
        if (sqlStateOf(error) === "23503") {
          throw new AppError(
            "EDITORIAL_PROFILE_REFERENCE_INVALID",
            "El corredor del perfil no existe",
            { details: { brokerId }, cause: error },
          );
        }
        throw error;
      }
    },
  };
}
