import {
  AppError,
  type RegistryRecord,
  type RegistryRepository,
  registryRecordSchema,
} from "@agentsales/core";
import { and, eq, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { sqlStateOf, withDbErrors } from "../errors.js";
import { registryRecords } from "../schema.js";

function toRecord(row: typeof registryRecords.$inferSelect): RegistryRecord {
  const parsed = registryRecordSchema.safeParse(row);
  if (!parsed.success) {
    throw new AppError("REGISTRY_ROW_INVALID", `El registro ${row.id} tiene datos inválidos`, {
      details: { id: row.id, issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

/** `RegistryRepository` sobre Drizzle (F12-T07). */
export function createRegistryRepository(db: SchemaDatabase): RegistryRepository {
  return {
    get(listingId) {
      return withDbErrors(async () => {
        const [row] = await db
          .select()
          .from(registryRecords)
          .where(eq(registryRecords.listingId, listingId));
        return row === undefined ? null : toRecord(row);
      });
    },

    async upsert(input) {
      try {
        return await withDbErrors(async () => {
          // Un solo comando: crea, o actualiza y baja a borrador solo si el contenido cambió.
          const [row] = await db
            .insert(registryRecords)
            .values({
              listingId: input.listingId,
              brokerId: input.brokerId,
              payload: input.payload,
              contentHash: input.contentHash,
            })
            .onConflictDoUpdate({
              target: registryRecords.listingId,
              set: {
                payload: sql`CASE WHEN ${registryRecords.contentHash} = excluded.content_hash THEN ${registryRecords.payload} ELSE excluded.payload END`,
                status: sql`CASE WHEN ${registryRecords.contentHash} = excluded.content_hash THEN ${registryRecords.status} ELSE 'draft'::registry_status END`,
                approvedAt: sql`CASE WHEN ${registryRecords.contentHash} = excluded.content_hash THEN ${registryRecords.approvedAt} ELSE NULL END`,
                approvedBy: sql`CASE WHEN ${registryRecords.contentHash} = excluded.content_hash THEN ${registryRecords.approvedBy} ELSE NULL END`,
                contentHash: sql`excluded.content_hash`,
                updatedAt: sql`CASE WHEN ${registryRecords.contentHash} = excluded.content_hash THEN ${registryRecords.updatedAt} ELSE now() END`,
              },
            })
            .returning();
          if (row === undefined) {
            throw new AppError("REGISTRY_WRITE_FAILED", "No se guardó el registro");
          }
          return toRecord(row);
        });
      } catch (error) {
        if (sqlStateOf(error) === "23503") {
          throw new AppError("REGISTRY_REFERENCE_INVALID", "La propiedad del registro no existe", {
            details: { listingId: input.listingId },
            cause: error,
          });
        }
        throw error;
      }
    },

    approve(listingId, userId, contentHash) {
      return withDbErrors(async () => {
        const [row] = await db
          .update(registryRecords)
          .set({ status: "approved", approvedAt: new Date(), approvedBy: userId })
          .where(
            and(
              eq(registryRecords.listingId, listingId),
              eq(registryRecords.status, "draft"),
              eq(registryRecords.contentHash, contentHash),
            ),
          )
          .returning();
        return row === undefined ? null : toRecord(row);
      });
    },

    withdraw(listingId) {
      return withDbErrors(async () => {
        const [row] = await db
          .update(registryRecords)
          .set({ status: "withdrawn" })
          .where(eq(registryRecords.listingId, listingId))
          .returning();
        return row === undefined ? null : toRecord(row);
      });
    },
  };
}
