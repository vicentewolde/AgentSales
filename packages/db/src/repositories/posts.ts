import {
  AppError,
  type Post,
  type PostRepository,
  type PostUpload,
  type PostUploadRepository,
  pickPostChanges,
  postSchema,
  postUploadSchema,
  scopedBrokerId,
} from "@agentsales/core";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { isUniqueViolation, sqlStateOf, withDbErrors } from "../errors.js";
import { posts, postUploads } from "../schema.js";

/** Fila → entidad. Una fila que no calza es `POST_ROW_INVALID` (no reintentable). */
function toPost(row: typeof posts.$inferSelect): Post {
  const parsed = postSchema.safeParse(row);
  if (!parsed.success) {
    throw new AppError("POST_ROW_INVALID", `El post ${row.id} tiene datos inválidos`, {
      details: { id: row.id, issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

const postNotFound = (id: string) =>
  new AppError("POST_NOT_FOUND", `No existe el post ${id}`, { details: { postId: id } });

/** `PostRepository` sobre Drizzle (ADR-0029): lectura y escritura básicas. */
export function createPostRepository(db: SchemaDatabase): PostRepository {
  return {
    async create(input) {
      try {
        return await withDbErrors(async () => {
          const [row] = await db
            .insert(posts)
            .values({
              brokerId: input.brokerId,
              topic: input.topic,
              kind: input.kind,
              brief: input.brief ?? null,
              briefOrigin: input.briefOrigin ?? "operator",
              status: input.status ?? "draft",
              source: input.source ?? "manual",
              pillar: input.pillar ?? null,
              plannedAt: input.plannedAt ?? null,
              planRunId: input.planRunId ?? null,
              createdBy: input.createdBy ?? null,
              rationale: input.rationale ?? null,
              xLinkAllowed: input.xLinkAllowed ?? false,
            })
            .returning();
          if (row === undefined) throw new AppError("POST_WRITE_FAILED", "No se creó el post");
          return toPost(row);
        });
      } catch (error) {
        // Un corredor, un plan o un usuario que no existen: un bug de quien llama.
        if (sqlStateOf(error) === "23503") {
          throw new AppError(
            "POST_REFERENCE_INVALID",
            "El corredor, el plan o el usuario del post no existen",
            { details: { brokerId: input.brokerId }, cause: error },
          );
        }
        throw error;
      }
    },

    get(id) {
      return withDbErrors(async () => {
        const [row] = await db.select().from(posts).where(eq(posts.id, id));
        return row === undefined ? null : toPost(row);
      });
    },

    list(filters, scope) {
      return withDbErrors(async () => {
        const scoped = scopedBrokerId(scope);
        const statuses =
          filters.status === undefined
            ? undefined
            : typeof filters.status === "string"
              ? [filters.status]
              : [...filters.status];
        const rows = await db
          .select()
          .from(posts)
          .where(
            and(
              scoped === undefined ? undefined : eq(posts.brokerId, scoped),
              filters.brokerId === undefined ? undefined : eq(posts.brokerId, filters.brokerId),
              statuses === undefined ? undefined : inArray(posts.status, statuses),
              filters.from === undefined ? undefined : gte(posts.plannedAt, filters.from),
              filters.to === undefined ? undefined : lt(posts.plannedAt, filters.to),
            ),
          )
          .orderBy(sql`${posts.plannedAt} asc nulls last`, asc(posts.createdAt), asc(posts.id));
        return rows.map(toPost);
      });
    },

    update(id, changes) {
      return withDbErrors(async () => {
        const [row] = await db
          .update(posts)
          .set({ ...pickPostChanges(changes), updatedAt: sql`now()` })
          .where(eq(posts.id, id))
          .returning();
        if (row === undefined) throw postNotFound(id);
        return toPost(row);
      });
    },

    archive(id) {
      return withDbErrors(async () => {
        const [row] = await db
          .update(posts)
          .set({ status: "archived", updatedAt: sql`now()` })
          .where(and(eq(posts.id, id), sql`${posts.status} <> 'archived'`))
          .returning();
        if (row !== undefined) return toPost(row);
        // Ya estaba archivado (se devuelve igual) o no existe.
        const [current] = await db.select().from(posts).where(eq(posts.id, id));
        if (current === undefined) throw postNotFound(id);
        return toPost(current);
      });
    },
  };
}

/** Fila → entidad. Una fila que no calza es `POST_UPLOAD_ROW_INVALID` (no reintentable). */
function toPostUpload(row: typeof postUploads.$inferSelect): PostUpload {
  const parsed = postUploadSchema.safeParse(row);
  if (!parsed.success) {
    throw new AppError("POST_UPLOAD_ROW_INVALID", `La subida ${row.id} tiene datos inválidos`, {
      details: { id: row.id, issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

/** `PostUploadRepository` sobre Drizzle (spec F9 §4.5, ADR-0025). */
export function createPostUploadRepository(db: SchemaDatabase): PostUploadRepository {
  const settle = (
    id: string,
    status: "completed" | "abandoned" | "uploaded",
    from: readonly ("pending" | "uploaded")[] = ["pending"],
  ) =>
    withDbErrors(async () => {
      // Condicional: solo una en `from` cambia (dos intentos solapados no se pisan).
      const updated = await db
        .update(postUploads)
        .set({ status, updatedAt: sql`now()` })
        .where(and(eq(postUploads.id, id), inArray(postUploads.status, [...from])))
        .returning({ id: postUploads.id });
      return updated.length > 0;
    });
  return {
    async create(input) {
      try {
        return await withDbErrors(async () => {
          const [row] = await db
            .insert(postUploads)
            .values({
              ...(input.id === undefined ? {} : { id: input.id }),
              postId: input.postId,
              objectPath: input.objectPath,
              expectedBytes: input.expectedBytes,
              expiresAt: input.expiresAt,
            })
            .returning();
          if (row === undefined) {
            throw new AppError("POST_UPLOAD_WRITE_FAILED", "No se creó la subida");
          }
          return toPostUpload(row);
        });
      } catch (error) {
        if (
          isUniqueViolation(error, "post_uploads_object_path_unique") ||
          isUniqueViolation(error, "post_uploads_pkey")
        ) {
          throw new AppError("POST_UPLOAD_CONFLICT", "Ya hay una subida con esa clave", {
            cause: error,
          });
        }
        if (sqlStateOf(error) === "23503") {
          throw new AppError("POST_UPLOAD_REFERENCE_INVALID", "El post de la subida no existe", {
            details: { postId: input.postId },
            cause: error,
          });
        }
        throw error;
      }
    },

    get(id) {
      return withDbErrors(async () => {
        const [row] = await db.select().from(postUploads).where(eq(postUploads.id, id));
        return row === undefined ? null : toPostUpload(row);
      });
    },

    listByPost(postId) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(postUploads)
          .where(eq(postUploads.postId, postId))
          .orderBy(asc(postUploads.createdAt), asc(postUploads.id));
        return rows.map(toPostUpload);
      });
    },

    listExpired(now) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(postUploads)
          .where(and(eq(postUploads.status, "pending"), lt(postUploads.expiresAt, now)))
          .orderBy(asc(postUploads.expiresAt), asc(postUploads.id));
        return rows.map(toPostUpload);
      });
    },

    markCompleted: (id) => settle(id, "completed", ["pending", "uploaded"]),
    markUploaded: (id) => settle(id, "uploaded"),
    markAbandoned: (id) => settle(id, "abandoned", ["pending", "uploaded"]),

    reopen(id, expiresAt) {
      return withDbErrors(async () => {
        const [row] = await db
          .update(postUploads)
          .set({ status: "pending", expiresAt, updatedAt: sql`now()` })
          .where(eq(postUploads.id, id))
          .returning();
        return row === undefined ? null : toPostUpload(row);
      });
    },
  };
}
