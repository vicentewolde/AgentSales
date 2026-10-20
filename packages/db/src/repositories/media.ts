import {
  AppError,
  checkArrangement,
  checkDerivative,
  checkNewMedia,
  type Media,
  type MediaRecord,
  type MediaRepository,
  mediaSchema,
  type NewMedia,
  type Subject,
  toSubject,
} from "@agentsales/core";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { isUniqueViolation, withDbErrors } from "../errors.js";
import { listings, media, posts } from "../schema.js";

/** Únicos de `media` (migraciones `0001`, `0005` y, de posts, `0015`) que dan `MEDIA_CONFLICT`. */
const CHECKSUM_UNIQUE = "media_original_listing_checksum_unique";
const POST_CHECKSUM_UNIQUE = "media_original_post_checksum_unique";
const STORAGE_PATH_UNIQUE = "media_storage_path_unique";
const PROCESSED_UNIQUE = "media_processed_parent_variant_unique";
const RENDERED_UNIQUE = "media_rendered_listing_variant_unique";
const MEDIA_UNIQUES = [
  CHECKSUM_UNIQUE,
  POST_CHECKSUM_UNIQUE,
  STORAGE_PATH_UNIQUE,
  PROCESSED_UNIQUE,
  RENDERED_UNIQUE,
];

/** La condición de los medios de un aviso o post. */
const ofSubject = (subject: Subject) =>
  subject.kind === "listing" ? eq(media.listingId, subject.id) : eq(media.postId, subject.id);

const subjectName = (subject: Subject) => (subject.kind === "listing" ? "aviso" : "post");
const subjectDetails = (subject: Subject) =>
  subject.kind === "listing" ? { listingId: subject.id } : { postId: subject.id };

const isMediaConflict = (error: unknown) =>
  MEDIA_UNIQUES.some((constraint) => isUniqueViolation(error, constraint));

/** Orden de `listByListing`: originales, variantes y renders (el enum sigue `MEDIA_ROLES`). */
const roleOrder = sql`case ${media.role} when 'original' then 0 when 'processed' then 1 else 2 end`;

/**
 * Fila → entidad. `variant` es texto en la base: se valida con `MEDIA_VARIANTS` al leer. Una fila
 * corrupta es `MEDIA_ROW_INVALID` (no reintentable; 500 en la API).
 */
function toMedia(row: typeof media.$inferSelect): Media {
  const parsed = mediaSchema.safeParse({
    id: row.id,
    listingId: row.listingId,
    postId: row.postId,
    brokerId: row.brokerId,
    kind: row.kind,
    role: row.role,
    variant: row.variant,
    parentMediaId: row.parentMediaId,
    storagePath: row.storagePath,
    mime: row.mime,
    width: row.width,
    height: row.height,
    durationS: row.durationS,
    bytes: row.bytes,
    checksum: row.checksum,
    sortOrder: row.sortOrder,
    isCover: row.isCover,
  });
  if (!parsed.success) {
    throw new AppError("MEDIA_ROW_INVALID", `El medio ${row.id} tiene datos inválidos`, {
      details: { id: row.id, issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

const recordColumns = {
  id: media.id,
  listingId: media.listingId,
  postId: media.postId,
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
    listOriginals(ref) {
      return withDbErrors(() =>
        db
          .select(recordColumns)
          .from(media)
          .where(and(ofSubject(toSubject(ref)), isOriginal))
          .orderBy(asc(media.sortOrder), asc(media.id)),
      );
    },

    listCovers(listingIds) {
      if (listingIds.length === 0) return Promise.resolve([]);
      return withDbErrors(() =>
        db
          .select(recordColumns)
          .from(media)
          .where(
            and(inArray(media.listingId, [...listingIds]), isOriginal, eq(media.isCover, true)),
          )
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
      checkNewMedia(data);
      try {
        return await withDbErrors(async (): Promise<MediaRecord> => {
          const [row] = await db
            .insert(media)
            .values({ ...data, postId: data.postId ?? null, role: "original" })
            .returning(recordColumns);
          if (row === undefined) throw new AppError("MEDIA_WRITE_FAILED", "No se creó el medio");
          return row;
        });
      } catch (error) {
        if (isMediaConflict(error)) {
          // Dos intentos del job solapados: el reintento lo encuentra y no lo vuelve a crear.
          throw new AppError("MEDIA_CONFLICT", `Ya existe el medio ${data.storagePath}`, {
            retriable: true,
            cause: error,
          });
        }
        throw error;
      }
    },

    async arrange(ref, items) {
      checkArrangement(items);
      if (items.length === 0) return;
      const subject = toSubject(ref);
      const own = ofSubject(subject);
      await withDbErrors(() =>
        db.transaction(async (tx) => {
          // Bloquea el aviso (o el post): dos `arrange` del mismo (intentos del job solapados) se
          // serializan. Sin esto, en READ COMMITTED cada uno desmarcaría solo las portadas ya
          // confirmadas y podrían quedar dos, o un orden cruzado de filas daría un deadlock.
          if (subject.kind === "listing") {
            await tx
              .select({ id: listings.id })
              .from(listings)
              .where(eq(listings.id, subject.id))
              .for("no key update");
          } else {
            await tx
              .select({ id: posts.id })
              .from(posts)
              .where(eq(posts.id, subject.id))
              .for("no key update");
          }
          const ids = items.map((item) => item.id);
          const found = await tx
            .select({ id: media.id })
            .from(media)
            .where(and(inArray(media.id, ids), own, isOriginal));
          if (found.length !== ids.length) {
            const known = new Set(found.map((row) => row.id));
            const missing = ids.filter((id) => !known.has(id));
            throw new AppError(
              "MEDIA_NOT_FOUND",
              `Hay medios que no son originales de ese ${subjectName(subject)}`,
              { details: { ...subjectDetails(subject), missing } },
            );
          }
          // Una sola portada por aviso o post: la nueva desmarca las demás, vengan o no en `items`.
          const cover = items.find((item) => item.isCover);
          if (cover !== undefined) {
            await tx
              .update(media)
              .set({ isCover: false })
              .where(and(own, isOriginal, eq(media.isCover, true), ne(media.id, cover.id)));
          }
          for (const { id, sortOrder, isCover } of items) {
            await tx
              .update(media)
              .set({ sortOrder, isCover })
              .where(and(eq(media.id, id), own, isOriginal));
          }
        }),
      );
    },

    listByListing(listingId) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(media)
          .where(eq(media.listingId, listingId))
          .orderBy(roleOrder, asc(media.sortOrder), asc(media.id));
        return rows.map(toMedia);
      });
    },

    listBySubject(subject) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(media)
          .where(ofSubject(subject))
          .orderBy(roleOrder, asc(media.sortOrder), asc(media.id));
        return rows.map(toMedia);
      });
    },

    get(id) {
      return withDbErrors(async () => {
        const [row] = await db.select().from(media).where(eq(media.id, id));
        return row === undefined ? null : toMedia(row);
      });
    },

    listVariants(parentMediaIds, variant) {
      if (parentMediaIds.length === 0) return Promise.resolve([]);
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(media)
          .where(
            and(
              eq(media.role, "processed"),
              eq(media.variant, variant),
              inArray(media.parentMediaId, [...parentMediaIds]),
            ),
          )
          .orderBy(asc(media.id));
        return rows.map(toMedia);
      });
    },

    updateMeasurements(id, { width, height, durationS }) {
      return withDbErrors(async () => {
        const updated = await db
          .update(media)
          .set({ width, height, durationS })
          .where(eq(media.id, id))
          .returning({ id: media.id });
        if (updated.length === 0) {
          throw new AppError("MEDIA_NOT_FOUND", `No existe el medio ${id}`, { details: { id } });
        }
      });
    },

    async upsertDerivative(derivative) {
      checkDerivative(derivative);
      // Un render siempre es de un aviso (`checkDerivative` rechaza el de un post).
      const subject: Subject =
        derivative.postId === undefined
          ? { kind: "listing", id: derivative.listingId }
          : { kind: "post", id: derivative.postId };
      try {
        return await withDbErrors(() =>
          db.transaction(async (tx) => {
            if (derivative.role === "processed") {
              // Bloquea el original: dos intentos solapados reemplazan su variante de a uno.
              const [parent] = await tx
                .select({ id: media.id })
                .from(media)
                .where(
                  and(
                    eq(media.id, derivative.parentMediaId),
                    ofSubject(subject),
                    eq(media.brokerId, derivative.brokerId),
                    isOriginal,
                  ),
                )
                .for("no key update");
              if (parent === undefined) {
                throw new AppError(
                  "MEDIA_NOT_FOUND",
                  `El original del derivado no es de ese ${subjectName(subject)}`,
                  {
                    details: {
                      ...subjectDetails(subject),
                      parentMediaId: derivative.parentMediaId,
                    },
                  },
                );
              }
            } else {
              // Un render no tiene padre: se bloquea el aviso, como en `arrange`.
              const [listing] = await tx
                .select({ id: listings.id })
                .from(listings)
                .where(and(eq(listings.id, subject.id), eq(listings.brokerId, derivative.brokerId)))
                .for("no key update");
              if (listing === undefined) {
                throw new AppError(
                  "MEDIA_NOT_FOUND",
                  "El aviso del render no existe o es de otro corredor",
                  {
                    details: { listingId: subject.id },
                  },
                );
              }
            }
            const [current] = await tx
              .select({ id: media.id, storagePath: media.storagePath })
              .from(media)
              .where(
                derivative.role === "processed"
                  ? and(
                      eq(media.role, "processed"),
                      eq(media.parentMediaId, derivative.parentMediaId),
                      eq(media.variant, derivative.variant),
                    )
                  : and(
                      eq(media.role, "rendered"),
                      eq(media.listingId, subject.id),
                      eq(media.variant, derivative.variant),
                    ),
              );
            const values = {
              ...derivative,
              listingId: derivative.listingId ?? null,
              postId: derivative.postId ?? null,
              sortOrder: 0,
              isCover: false,
            };
            const [row] =
              current === undefined
                ? await tx.insert(media).values(values).returning()
                : await tx.update(media).set(values).where(eq(media.id, current.id)).returning();
            if (row === undefined) {
              // El vigente se borró entre la lectura y el reemplazo (`deleteDerivative` no toma el
              // bloqueo del original): reintentar lo crea de nuevo.
              throw new AppError("MEDIA_CONFLICT", `El derivado ${derivative.storagePath} cambió`, {
                retriable: true,
              });
            }
            const previousPath =
              current !== undefined && current.storagePath !== derivative.storagePath
                ? current.storagePath
                : null;
            return { media: toMedia(row), previousPath };
          }),
        );
      } catch (error) {
        if (isMediaConflict(error)) {
          // Dos intentos solapados: el reintento encuentra el vigente y lo reemplaza.
          throw new AppError("MEDIA_CONFLICT", `Ya existe el medio ${derivative.storagePath}`, {
            retriable: true,
            cause: error,
          });
        }
        throw error;
      }
    },

    deleteDerivative(id) {
      return withDbErrors(async () => {
        const [deleted] = await db
          .delete(media)
          .where(and(eq(media.id, id), ne(media.role, "original")))
          .returning({ storagePath: media.storagePath });
        return deleted?.storagePath ?? null;
      });
    },
  };
}
