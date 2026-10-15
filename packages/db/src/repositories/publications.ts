import {
  AppError,
  canTransition,
  checkPublicationProgress,
  checkRemoteState,
  normalizeEventPayload,
  type Publication,
  type PublicationChanges,
  type PublicationEvent,
  type PublicationRepository,
  publicationEventSchema,
  publicationSchema,
  requirePublicationMode,
  TERMINAL_PUBLICATION_STATUSES,
} from "@agentsales/core";
import { and, asc, eq, gte, inArray, lt, lte, notInArray, or, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { isUniqueViolation, sqlStateOf, withDbErrors } from "../errors.js";
import { publicationEvents, publications } from "../schema.js";

type Row = typeof publications.$inferSelect;

/** Las activas (no terminales), como el único `publications_one_active_per_format`. */
const activeStatus = sql.raw(
  `"publications"."status" NOT IN (${TERMINAL_PUBLICATION_STATUSES.map((status) => `'${status}'`).join(", ")})`,
);
type EventRow = typeof publicationEvents.$inferSelect;
type Writer = Pick<SchemaDatabase, "insert">;

const ONE_ACTIVE_PER_FORMAT = "publications_one_active_per_format";
const ONE_RELIST_PER_PUBLICATION = "publications_relisted_from_unique";

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
    remoteState: row.remoteState,
    listingSourceHash: row.listingSourceHash,
    relistedFrom: row.relistedFrom,
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

const progressStale = (id: string) =>
  new AppError(
    "PUBLICATION_PROGRESS_STALE",
    "La publicación cambió: su progreso ya no es de ese intento",
    { details: { publicationId: id } },
  );

const rescheduleStale = (id: string) =>
  new AppError(
    "INVALID_TRANSITION",
    "La publicación ya no está programada a esa hora: recarga y vuelve a intentarlo",
    { details: { publicationId: id, from: "scheduled", to: "scheduled" } },
  );

const publicationStale = (id: string) =>
  new AppError("PUBLICATION_STALE", "La publicación cambió mientras tanto: recarga", {
    details: { publicationId: id },
  });

/** Columnas de una transición (lo mismo que aplica el doble en memoria). */
function columnsOf(
  publication: Pick<Row, "platform">,
  to: Row["status"],
  changes: PublicationChanges,
) {
  return {
    // La hora programada solo vive en `scheduled` (ADR-0018): al salir se borra.
    scheduledAt: to === "scheduled" ? (changes.scheduledAt ?? null) : null,
    ...(changes.dryRun === undefined ? {} : { dryRun: changes.dryRun }),
    ...(changes.incrementAttempts ? { attempts: sql`${publications.attempts} + 1` } : {}),
    ...(changes.externalId === undefined ? {} : { externalId: changes.externalId }),
    ...(changes.externalUrl === undefined ? {} : { externalUrl: changes.externalUrl }),
    ...(changes.publishedAt === undefined ? {} : { publishedAt: changes.publishedAt }),
    ...(changes.lastError === undefined ? {} : { lastError: changes.lastError }),
    ...(changes.progress === undefined
      ? {}
      : { progress: checkPublicationProgress(publication.platform, changes.progress) }),
    ...(changes.remoteState === undefined
      ? {}
      : { remoteState: checkRemoteState(changes.remoteState) }),
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
                // Vacío cuenta como sin versión: nunca se compara contra "".
                listingSourceHash: input.listingSourceHash || null,
                relistedFrom: input.relistedFrom ?? null,
                status: "approved",
                // El valor seguro: el modo de verdad se fija al pasar a `publishing`.
                dryRun: true,
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
        if (isUniqueViolation(error, ONE_RELIST_PER_PUBLICATION)) {
          throw new AppError("PUBLICATION_CONFLICT", "Esa publicación ya se republicó", {
            details: { relistedFrom: input.relistedFrom },
          });
        }
        // Una FK (aviso, cuenta o texto) que no existe: un bug de quien llama.
        if (sqlStateOf(error) === "23503") {
          throw new AppError(
            "PUBLICATION_REFERENCE_INVALID",
            "El aviso, la cuenta o el texto de la publicación no existen",
            { details: { listingId: input.listingId } },
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

    listDue({ now, since, excludePlatforms, limit }) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(publications)
          .where(
            and(
              eq(publications.status, "scheduled"),
              lte(publications.scheduledAt, now),
              gte(publications.scheduledAt, since),
              excludePlatforms.length === 0
                ? undefined
                : notInArray(publications.platform, [...excludePlatforms]),
            ),
          )
          .orderBy(asc(publications.scheduledAt), asc(publications.id))
          .limit(limit);
        return rows.map(toPublication);
      });
    },

    listStalePublishing({ before, excludePlatforms }) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(publications)
          .where(
            and(
              eq(publications.status, "publishing"),
              lt(publications.updatedAt, before),
              excludePlatforms.length === 0
                ? undefined
                : notInArray(publications.platform, [...excludePlatforms]),
            ),
          )
          .orderBy(asc(publications.updatedAt), asc(publications.id));
        return rows.map(toPublication);
      });
    },

    listForTracking({ listingIds, since }) {
      if (listingIds.length === 0) return Promise.resolve([]);
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(publications)
          .where(
            and(
              inArray(publications.listingId, [...listingIds]),
              or(sql`${activeStatus}`, gte(publications.updatedAt, since)),
            ),
          )
          .orderBy(asc(publications.listingId), asc(publications.createdAt), asc(publications.id));
        return rows.map(toPublication);
      });
    },

    async reschedule(id, { expectedAt, at, dryRun }, event) {
      const payload = normalizeEventPayload(event.payload);
      if ((await findRow(id)) === undefined) throw notFound(id);
      const row = await withDbErrors(() =>
        db.transaction(async (tx) => {
          const [updated] = await tx
            .update(publications)
            .set({ scheduledAt: at, dryRun, updatedAt: sql`clock_timestamp()` })
            .where(
              and(
                eq(publications.id, id),
                eq(publications.status, "scheduled"),
                eq(publications.scheduledAt, expectedAt),
              ),
            )
            .returning();
          if (updated === undefined) return undefined;
          await insertEvent(tx, id, {
            type: "schedule_changed",
            fromStatus: null,
            toStatus: null,
            actor: event.actor,
            payload,
          });
          return updated;
        }),
      );
      if (row === undefined) throw rescheduleStale(id);
      return toPublication(row);
    },

    async replacePublishedSource(id, guard, source, event) {
      const current = await findRow(id);
      if (current === undefined) throw notFound(id);
      // Primero los datos y después el estado, como el doble en memoria.
      const payload = normalizeEventPayload(event.payload);
      const progress = checkPublicationProgress(current.platform, source.progress);
      const row = await withDbErrors(() =>
        db.transaction(async (tx) => {
          const [updated] = await tx
            .update(publications)
            .set({
              contentId: source.contentId,
              listingSourceHash: source.listingSourceHash || null,
              progress,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(and(eq(publications.id, id), eq(publications.status, guard.from)))
            .returning();
          if (updated === undefined) return undefined;
          await insertEvent(tx, id, {
            type: "manual_edit",
            fromStatus: null,
            toStatus: null,
            actor: event.actor,
            payload,
          });
          return updated;
        }),
      );
      if (row === undefined) throw publicationStale(id);
      return toPublication(row);
    },

    async transition(id, { from, to, changes = {} }, event) {
      const current = await findRow(id);
      if (current === undefined) throw notFound(id);
      const invalid = () =>
        new AppError("INVALID_TRANSITION", `Transición inválida de ${from} a ${to}`, {
          details: { publicationId: id, from, to },
        });
      // Primero los datos y después el estado, como el doble en memoria.
      const payload = normalizeEventPayload(event.payload);
      const columns = columnsOf(current, to, changes);
      requirePublicationMode(to, changes);
      if (!canTransition(from, to)) throw invalid();
      const row = await withDbErrors(() =>
        db.transaction(async (tx) => {
          const [updated] = await tx
            .update(publications)
            .set({ ...columns, status: to, updatedAt: sql`clock_timestamp()` })
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
          .set({ progress: checked, updatedAt: sql`clock_timestamp()` })
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

    async updateProgress(id, guard, progress) {
      const current = await findRow(id);
      if (current === undefined) throw notFound(id);
      const checked = checkPublicationProgress(current.platform, progress);
      const [row] = await withDbErrors(() =>
        db
          .update(publications)
          .set({ progress: checked, updatedAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(publications.id, id),
              eq(publications.status, guard.from),
              eq(publications.attempts, guard.attempts),
            ),
          )
          .returning(),
      );
      if (row === undefined) throw progressStale(id);
      return toPublication(row);
    },

    async setRemoteState(id, remoteState, event) {
      // Primero los datos, como el doble en memoria.
      const checked = checkRemoteState(remoteState);
      const payload = event === undefined ? undefined : normalizeEventPayload(event.payload);
      const row = await withDbErrors(() =>
        db.transaction(async (tx) => {
          const [updated] = await tx
            .update(publications)
            .set({ remoteState: checked, updatedAt: sql`clock_timestamp()` })
            .where(eq(publications.id, id))
            .returning();
          if (updated === undefined) return undefined;
          if (event !== undefined) {
            await insertEvent(tx, id, {
              type: event.type,
              fromStatus: null,
              toStatus: null,
              actor: event.actor,
              payload,
            });
          }
          return updated;
        }),
      );
      if (row === undefined) throw notFound(id);
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

    countLiveAttemptsSince(platformAccountId, since) {
      return withDbErrors(async () => {
        const [row] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(publicationEvents)
          .innerJoin(publications, eq(publications.id, publicationEvents.publicationId))
          .where(
            and(
              eq(publications.platformAccountId, platformAccountId),
              eq(publicationEvents.type, "publish_attempt"),
              sql`${publicationEvents.payload}->>'mode' = 'live'`,
              gte(publicationEvents.createdAt, since),
            ),
          );
        return row?.count ?? 0;
      });
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
