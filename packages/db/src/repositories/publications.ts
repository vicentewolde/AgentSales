import {
  AppError,
  canTransition,
  checkPublicationProgress,
  normalizeEventPayload,
  type Publication,
  type PublicationChanges,
  type PublicationEvent,
  type PublicationRepository,
  publicationEventSchema,
  publicationSchema,
} from "@agentsales/core";
import { and, asc, eq, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { isUniqueViolation, withDbErrors } from "../errors.js";
import { publicationEvents, publications } from "../schema.js";

type Row = typeof publications.$inferSelect;
type EventRow = typeof publicationEvents.$inferSelect;
type Writer = Pick<SchemaDatabase, "insert">;

const ONE_ACTIVE_PER_FORMAT = "publications_one_active_per_format";

/** Fila → entidad. Una fila que no calza (también un `progress` ajeno) es `PUBLICATION_ROW_INVALID`. */
function toPublication(row: Row): Publication {
  const parsed = publicationSchema.safeParse({
    id: row.id,
    listingId: row.listingId,
    platformAccountId: row.platformAccountId,
    platform: row.platform,
    format: row.format,
    contentId: row.contentId,
    mediaIds: row.mediaIds,
    status: row.status,
    scheduledAt: row.scheduledAt,
    publishedAt: row.publishedAt,
    externalId: row.externalId,
    externalUrl: row.externalUrl,
    attempts: row.attempts,
    lastError: row.lastError,
    dryRun: row.dryRun,
    progress: row.progress,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  if (!parsed.success) {
    throw new AppError(
      "PUBLICATION_ROW_INVALID",
      `La publicación ${row.id} tiene datos inválidos`,
      {
        details: { id: row.id, issues: parsed.error.issues },
      },
    );
  }
  return parsed.data;
}

function toEvent(row: EventRow): PublicationEvent {
  const parsed = publicationEventSchema.safeParse(row);
  if (!parsed.success) {
    throw new AppError(
      "PUBLICATION_EVENT_ROW_INVALID",
      `El evento ${row.id} tiene datos inválidos`,
      {
        details: { id: row.id, issues: parsed.error.issues },
      },
    );
  }
  return parsed.data;
}

const notFound = (id: string) =>
  new AppError("PUBLICATION_NOT_FOUND", `No existe la publicación ${id}`, {
    details: { publicationId: id },
  });

/** Columnas de una transición (lo mismo que aplica el doble en memoria). */
function columnsOf(publication: Pick<Row, "platform">, changes: PublicationChanges) {
  return {
    ...(changes.dryRun === undefined ? {} : { dryRun: changes.dryRun }),
    ...(changes.incrementAttempts ? { attempts: sql`${publications.attempts} + 1` } : {}),
    ...(changes.externalId === undefined ? {} : { externalId: changes.externalId }),
    ...(changes.externalUrl === undefined ? {} : { externalUrl: changes.externalUrl }),
    ...(changes.publishedAt === undefined ? {} : { publishedAt: changes.publishedAt }),
    ...(changes.lastError === undefined ? {} : { lastError: changes.lastError }),
    ...(changes.progress === undefined
      ? {}
      : { progress: checkPublicationProgress(publication.platform, changes.progress) }),
  };
}

/**
 * `PublicationRepository` sobre Drizzle (ADR-0014). Cada cambio de estado escribe la fila y su
 * evento en una transacción (dentro del candado del aviso es un savepoint) y es condicional.
 */
export function createPublicationRepository(db: SchemaDatabase): PublicationRepository {
  const insertEvent = async (
    writer: Writer,
    publicationId: string,
    values: Omit<typeof publicationEvents.$inferInsert, "publicationId">,
  ) => {
    // `clock_timestamp()` y no `now()`: dentro de una transacción `now()` es la misma hora para
    // todo, y la bitácora (y las dos publicaciones de un aviso) se ordenan por `created_at`.
    const [row] = await writer
      .insert(publicationEvents)
      .values({ ...values, publicationId, createdAt: sql`clock_timestamp()` })
      .returning();
    if (row === undefined) throw new Error("evento sin fila");
    return toEvent(row);
  };

  const findRow = (id: string) =>
    withDbErrors(async () => {
      const [row] = await db.select().from(publications).where(eq(publications.id, id));
      return row;
    });

  return {
    async create(input, event) {
      const payload = normalizeEventPayload(event.payload);
      try {
        return await withDbErrors(() =>
          db.transaction(async (tx) => {
            const [row] = await tx
              .insert(publications)
              .values({
                listingId: input.listingId,
                platformAccountId: input.platformAccountId,
                platform: input.platform,
                format: input.format,
                contentId: input.contentId,
                mediaIds: [...input.mediaIds],
                status: "approved",
                dryRun: input.dryRun,
                createdAt: sql`clock_timestamp()`,
                updatedAt: sql`clock_timestamp()`,
              })
              .returning();
            if (row === undefined) throw new Error("publicación sin fila");
            await insertEvent(tx, row.id, {
              type: "status_changed",
              fromStatus: null,
              toStatus: "approved",
              actor: event.actor,
              payload,
            });
            return toPublication(row);
          }),
        );
      } catch (error) {
        if (isUniqueViolation(error, ONE_ACTIVE_PER_FORMAT)) {
          throw new AppError(
            "PUBLICATION_CONFLICT",
            "Ya hay una publicación activa de ese aviso, cuenta y formato",
            { details: { listingId: input.listingId, format: input.format } },
          );
        }
        throw error;
      }
    },

    async get(id) {
      const row = await findRow(id);
      return row === undefined ? null : toPublication(row);
    },

    listByListing(listingId) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(publications)
          .where(eq(publications.listingId, listingId))
          .orderBy(asc(publications.createdAt), asc(publications.id));
        return rows.map(toPublication);
      });
    },

    listByStatus(status) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(publications)
          .where(eq(publications.status, status))
          .orderBy(asc(publications.createdAt), asc(publications.id));
        return rows.map(toPublication);
      });
    },

    async transition(id, { from, to, changes = {} }, event) {
      const current = await findRow(id);
      if (current === undefined) throw notFound(id);
      const invalid = () =>
        new AppError("INVALID_TRANSITION", `Transición inválida de ${from} a ${to}`, {
          details: { publicationId: id, from, to },
        });
      if (!canTransition(from, to)) throw invalid();
      const payload = normalizeEventPayload(event.payload);
      const columns = columnsOf(current, changes);
      const row = await withDbErrors(() =>
        db.transaction(async (tx) => {
          const [updated] = await tx
            .update(publications)
            .set({ ...columns, status: to })
            .where(and(eq(publications.id, id), eq(publications.status, from)))
            .returning();
          if (updated === undefined) return undefined;
          await insertEvent(tx, id, {
            type: "status_changed",
            fromStatus: from,
            toStatus: to,
            actor: event.actor,
            payload,
          });
          return updated;
        }),
      );
      if (row === undefined) throw invalid();
      return toPublication(row);
    },

    async saveProgress(id, progress) {
      const current = await findRow(id);
      if (current === undefined) throw notFound(id);
      const checked = checkPublicationProgress(current.platform, progress);
      const [row] = await withDbErrors(() =>
        db
          .update(publications)
          .set({ progress: checked })
          .where(and(eq(publications.id, id), eq(publications.status, "publishing")))
          .returning(),
      );
      if (row === undefined) {
        throw new AppError(
          "PUBLICATION_NOT_PUBLISHING",
          "La publicación ya no se está publicando",
          {
            details: { publicationId: id },
          },
        );
      }
      return toPublication(row);
    },

    async addEvent(publicationId, event) {
      const payload = normalizeEventPayload(event.payload);
      if ((await findRow(publicationId)) === undefined) throw notFound(publicationId);
      return withDbErrors(() =>
        insertEvent(db, publicationId, {
          type: event.type,
          fromStatus: null,
          toStatus: null,
          actor: event.actor,
          payload,
        }),
      );
    },

    listEvents(publicationId) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(publicationEvents)
          .where(eq(publicationEvents.publicationId, publicationId))
          .orderBy(asc(publicationEvents.createdAt), asc(publicationEvents.id));
        return rows.map(toEvent);
      });
    },
  };
}
