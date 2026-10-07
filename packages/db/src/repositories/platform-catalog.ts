import {
  AppError,
  type PlatformCatalogEntry,
  type PlatformCatalogRepository,
  platformCatalogEntrySchema,
} from "@agentsales/core";
import { and, eq, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { withDbErrors } from "../errors.js";
import { platformCatalog } from "../schema.js";

/** Una entrada que no calza con `platformCatalogEntrySchema`: la arma el servidor, no se reintenta. */
const rowInvalid = (entry: Pick<PlatformCatalogEntry, "platform" | "key">) =>
  new AppError("PLATFORM_CATALOG_ROW_INVALID", "La entrada del catálogo no es válida", {
    details: { platform: entry.platform, key: entry.key },
  });

/**
 * `PlatformCatalogRepository` sobre Drizzle (ADR-0015 punto 5, spec F4-T09): la tabla
 * `platform_catalog` con llave `(platform, key)`. Guardar reemplaza la entrada de la misma clave.
 */
export function createPlatformCatalogRepository(db: SchemaDatabase): PlatformCatalogRepository {
  return {
    async get(platform, key) {
      return withDbErrors(async () => {
        const [row] = await db
          .select()
          .from(platformCatalog)
          .where(and(eq(platformCatalog.platform, platform), eq(platformCatalog.key, key)));
        if (row === undefined) return null;
        const parsed = platformCatalogEntrySchema.safeParse({
          platform: row.platform,
          key: row.key,
          data: row.data,
          fetchedAt: row.fetchedAt,
        });
        if (!parsed.success) throw rowInvalid(row);
        return parsed.data;
      });
    },

    async put(entry) {
      const parsed = platformCatalogEntrySchema.safeParse(entry);
      if (!parsed.success) throw rowInvalid(entry);
      const { platform, key, data, fetchedAt } = parsed.data;
      await withDbErrors(() =>
        db
          .insert(platformCatalog)
          .values({ platform, key, data, fetchedAt })
          .onConflictDoUpdate({
            target: [platformCatalog.platform, platformCatalog.key],
            set: { data, fetchedAt, updatedAt: sql`now()` },
          }),
      );
    },
  };
}
