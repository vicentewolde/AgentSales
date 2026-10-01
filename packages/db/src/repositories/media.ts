import {
  AppError,
  checkArrangement,
  type MediaRecord,
  type MediaRepository,
  type NewMedia,
} from "@agentsales/core";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { isUniqueViolation, withDbErrors } from "../errors.js";
import { listings, media } from "../schema.js";

/** Únicos de `media` (migración `0001`) que dan `MEDIA_CONFLICT`. */
const CHECKSUM_UNIQUE = "media_original_listing_checksum_unique";
const STORAGE_PATH_UNIQUE = "media_storage_path_unique";

const recordColumns = {
  id: media.id,
  listingId: media.listingId,
  brokerId: media.brokerId,
  kind: media.kind,
  storagePath: media.storagePath,
  mime: media.mime,
  bytes: media.bytes,
  checksum: media.checksum,
  sortOrder: media.sortOrder,
  isCover: media.isCover,
};

/** Solo originales: los derivados (`processed`, `rendered`) llegan en F2 y no son de la ingesta. */
const isOriginal = eq(media.role, "original");

/** `MediaRepository` sobre Drizzle (node-postgres en las apps, PGlite en los tests). */
export function createMediaRepository(db: SchemaDatabase): MediaRepository {
  return {
    listOriginals(listingId) {
      return withDbErrors(() =>
        db
          .select(recordColumns)
          .from(media)
          .where(and(eq(media.listingId, listingId), isOriginal))
          .orderBy(asc(media.sortOrder), asc(media.id)),
      );
    },

    findByStoragePath(storagePath) {
      return withDbErrors(async () => {
        const [row] = await db
          .select(recordColumns)
          .from(media)
          .where(and(eq(media.storagePath, storagePath), isOriginal));
        return row ?? null;
      });
    },

    async create(data: NewMedia) {
      try {
        return await withDbErrors(async (): Promise<MediaRecord> => {
          const [row] = await db
            .insert(media)
            .values({ ...data, role: "original" })
            .returning(recordColumns);
          if (row === undefined) throw new AppError("MEDIA_WRITE_FAILED", "No se creó el medio");
          return row;
        });
      } catch (error) {
        if (
          isUniqueViolation(error, CHECKSUM_UNIQUE) ||
          isUniqueViolation(error, STORAGE_PATH_UNIQUE)
        ) {
          // Dos intentos del job solapados: el reintento lo encuentra y no lo vuelve a crear.
          throw new AppError("MEDIA_CONFLICT", `Ya existe el medio ${data.storagePath}`, {
            retriable: true,
            cause: error,
          });
        }
        throw error;
      }
    },

    async arrange(listingId, items) {
      checkArrangement(items);
      if (items.length === 0) return;
      await withDbErrors(() =>
        db.transaction(async (tx) => {
          // Bloquea el aviso: dos `arrange` del mismo aviso (intentos del job solapados) se
          // serializan. Sin esto, en READ COMMITTED cada uno desmarcaría solo las portadas ya
          // confirmadas y podrían quedar dos, o un orden cruzado de filas daría un deadlock.
          await tx
            .select({ id: listings.id })
            .from(listings)
            .where(eq(listings.id, listingId))
            .for("no key update");
          const ids = items.map((item) => item.id);
          const found = await tx
            .select({ id: media.id })
            .from(media)
            .where(and(inArray(media.id, ids), eq(media.listingId, listingId), isOriginal));
          if (found.length !== ids.length) {
            const known = new Set(found.map((row) => row.id));
            const missing = ids.filter((id) => !known.has(id));
            throw new AppError("MEDIA_NOT_FOUND", "Hay medios que no son originales de ese aviso", {
              details: { listingId, missing },
            });
          }
          // Una sola portada por aviso: la nueva desmarca las demás, vengan o no en `items`.
          const cover = items.find((item) => item.isCover);
          if (cover !== undefined) {
            await tx
              .update(media)
              .set({ isCover: false })
              .where(
                and(
                  eq(media.listingId, listingId),
                  isOriginal,
                  eq(media.isCover, true),
                  ne(media.id, cover.id),
                ),
              );
          }
          for (const { id, sortOrder, isCover } of items) {
            await tx
              .update(media)
              .set({ sortOrder, isCover })
              .where(and(eq(media.id, id), eq(media.listingId, listingId), isOriginal));
          }
        }),
      );
    },
  };
}
