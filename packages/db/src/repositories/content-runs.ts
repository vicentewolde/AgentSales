import {
  ACTIVE_CONTENT_RUN_STATUSES,
  AppError,
  addLlmCall,
  type ContentRun,
  type ContentRunRepository,
  checkNewContents,
  contentRunSchema,
  languageOf,
  llmUsageSchema,
  type Subject,
  subjectFieldsOf,
  subjectOfInput,
  toSubject,
} from "@agentsales/core";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { isUniqueViolation, withDbErrors } from "../errors.js";
import { contentRuns, contents, listings, planRuns, posts } from "../schema.js";

/** Una corrida activa por aviso y, desde F9, por post: los dos dan `CONTENT_RUN_CONFLICT`. */
const ONE_ACTIVE = ["content_runs_one_active_per_listing", "content_runs_one_active_per_post"];
const RUN_PLATFORM_UNIQUE = "contents_run_platform_language_unique";

/** La condición de las corridas de un aviso o post. */
const ofSubject = (subject: Subject) =>
  subject.kind === "listing"
    ? eq(contentRuns.listingId, subject.id)
    : eq(contentRuns.postId, subject.id);

/**
 * Fila → entidad. `stage`, `report` y `error` los escribió otro proceso: se validan al leerlos.
 * Una fila corrupta es `CONTENT_RUN_ROW_INVALID` (no reintentable), con el detalle en `details`.
 */
function toContentRun(row: typeof contentRuns.$inferSelect): ContentRun {
  const parsed = contentRunSchema.safeParse({
    id: row.id,
    // Exactamente uno de `listing_id` y `post_id` (ADR-0029); si no, la fila no valida.
    ...subjectFieldsOf(row),
    status: row.status,
    texts: row.texts,
    stage: row.stage,
    report: row.report,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    llmUsage: row.llmUsage,
  });
  if (!parsed.success) {
    throw new AppError(
      "CONTENT_RUN_ROW_INVALID",
      `La corrida de contenido ${row.id} tiene datos inválidos`,
      {
        details: { id: row.id, issues: parsed.error.issues },
      },
    );
  }
  return parsed.data;
}

const isActive = inArray(contentRuns.status, [...ACTIVE_CONTENT_RUN_STATUSES]);

/**
 * Los barridos de avisos (reencolar `content.prepare`, retomar `auto_publish`) no ven las corridas
 * de posts (F9, ADR-0029): esas no son de `content.prepare` ni tienen `auto_publish`.
 */
const ofListing = isNotNull(contentRuns.listingId);

/** `ContentRunRepository` sobre Drizzle (node-postgres en las apps, PGlite en los tests). */
export function createContentRunRepository(db: SchemaDatabase): ContentRunRepository {
  return {
    async create(run) {
      const subject = subjectOfInput(run);
      try {
        return await withDbErrors(async () => {
          const [row] = await db
            .insert(contentRuns)
            .values({
              ...(subject.kind === "listing" ? { listingId: subject.id } : { postId: subject.id }),
              texts: run.texts,
            })
            .returning();
          if (row === undefined) {
            throw new AppError("CONTENT_RUN_WRITE_FAILED", "No se creó la corrida de contenido");
          }
          return toContentRun(row);
        });
      } catch (error) {
        // Otra petición ganó la carrera: quien llama busca la activa con `findActive`.
        if (ONE_ACTIVE.some((constraint) => isUniqueViolation(error, constraint))) {
          throw new AppError(
            "CONTENT_RUN_CONFLICT",
            `${subject.kind === "listing" ? "El aviso" : "El post"} ${subject.id} ya tiene una corrida de contenido en curso`,
            { retriable: true, cause: error },
          );
        }
        throw error;
      }
    },

    get(id) {
      return withDbErrors(async () => {
        const [row] = await db.select().from(contentRuns).where(eq(contentRuns.id, id));
        return row === undefined ? null : toContentRun(row);
      });
    },

    findActive(ref) {
      return withDbErrors(async () => {
        const [row] = await db
          .select()
          .from(contentRuns)
          .where(and(ofSubject(toSubject(ref)), isActive));
        return row === undefined ? null : toContentRun(row);
      });
    },

    latest(ref) {
      return withDbErrors(async () => {
        const [row] = await db
          .select()
          .from(contentRuns)
          .where(ofSubject(toSubject(ref)))
          .orderBy(desc(contentRuns.createdAt), desc(contentRuns.id))
          .limit(1);
        return row === undefined ? null : toContentRun(row);
      });
    },

    listQueued(kind = "listing") {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(contentRuns)
          .where(
            and(
              eq(contentRuns.status, "queued"),
              kind === "listing" ? ofListing : isNotNull(contentRuns.postId),
            ),
          )
          .orderBy(asc(contentRuns.createdAt), asc(contentRuns.id));
        return rows.map(toContentRun);
      });
    },

    listAutoPublishPending(finishedSince) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(contentRuns)
          .where(
            and(
              eq(contentRuns.status, "succeeded"),
              ofListing,
              eq(contentRuns.texts, true),
              isNull(contentRuns.autoPublishDoneAt),
              gte(contentRuns.finishedAt, finishedSince),
            ),
          )
          .orderBy(asc(contentRuns.finishedAt), asc(contentRuns.id));
        return rows.map(toContentRun);
      });
    },

    markAutoPublishDone(id) {
      return withDbErrors(async () => {
        // Condicional: solo la primera llamada lo anota (un segundo worker recibe `false`).
        const updated = await db
          .update(contentRuns)
          .set({ autoPublishDoneAt: sql`now()` })
          .where(
            and(
              eq(contentRuns.id, id),
              eq(contentRuns.status, "succeeded"),
              isNull(contentRuns.autoPublishDoneAt),
            ),
          )
          .returning({ id: contentRuns.id });
        return updated.length > 0;
      });
    },

    markRunning(id) {
      return withDbErrors(async () => {
        const updated = await db
          .update(contentRuns)
          // `started_at` es el del primer intento: un reintento no lo mueve.
          .set({ status: "running", startedAt: sql`coalesce(${contentRuns.startedAt}, now())` })
          .where(and(eq(contentRuns.id, id), isActive))
          .returning({ id: contentRuns.id });
        return updated.length > 0;
      });
    },

    setStage(id, stage) {
      return withDbErrors(async () => {
        const updated = await db
          .update(contentRuns)
          .set({ stage })
          .where(and(eq(contentRuns.id, id), eq(contentRuns.status, "running")))
          .returning({ id: contentRuns.id });
        return updated.length > 0;
      });
    },

    async markSucceeded(id, { report, contents: rows }) {
      checkNewContents(rows);
      try {
        return await withDbErrors(() =>
          db.transaction(async (tx) => {
            const [run] = await tx
              .update(contentRuns)
              .set({ status: "succeeded", report, finishedAt: sql`now()` })
              .where(and(eq(contentRuns.id, id), eq(contentRuns.status, "running")))
              .returning({ listingId: contentRuns.listingId, postId: contentRuns.postId });
            if (run === undefined) return false;
            if (rows.length > 0) {
              await tx.insert(contents).values(
                rows.map((row) => ({
                  ...row,
                  language: languageOf(row),
                  // Los textos son del aviso o del post de la corrida (ADR-0029).
                  listingId: run.listingId,
                  postId: run.postId,
                  contentRunId: id,
                  // jsonb NOT NULL: una salida ausente se guarda como `null` de JSON. Drizzle
                  // convierte el `null` de JavaScript en NULL de SQL, así que va explícito.
                  rawOutput: row.rawOutput ?? sql`'null'::jsonb`,
                })),
              );
            }
            return true;
          }),
        );
      } catch (error) {
        // Un canal que ya tenía fila: la transacción se deshizo completa, y el intento termina
        // como `skipped` (spec F2 §4.4).
        if (isUniqueViolation(error, RUN_PLATFORM_UNIQUE)) return false;
        throw error;
      }
    },

    markFailed(id, error, report) {
      return withDbErrors(async () => {
        const updated = await db
          .update(contentRuns)
          .set({
            status: "failed",
            error,
            ...(report === undefined ? {} : { report }),
            finishedAt: sql`now()`,
          })
          .where(and(eq(contentRuns.id, id), isActive))
          .returning({ id: contentRuns.id });
        return updated.length > 0;
      });
    },

    failAbandoned(startedBefore, error) {
      return withDbErrors(async () => {
        const closed = await db
          .update(contentRuns)
          .set({ status: "failed", error, finishedAt: sql`now()` })
          .where(and(eq(contentRuns.status, "running"), lt(contentRuns.startedAt, startedBefore)))
          .returning({ id: contentRuns.id });
        return closed.map((row) => row.id);
      });
    },

    addLlmUsage(id, call) {
      return withDbErrors(() =>
        db.transaction(async (tx) => {
          // La fila bloqueada: dos llamadas que vuelven a la vez suman las dos.
          const [row] = await tx
            .select()
            .from(contentRuns)
            .where(eq(contentRuns.id, id))
            .for("update");
          if (row === undefined) {
            throw new AppError("CONTENT_RUN_NOT_FOUND", `No existe la corrida de contenido ${id}`);
          }
          const previous = row.llmUsage === null ? null : llmUsageSchema.parse(row.llmUsage);
          const [updated] = await tx
            .update(contentRuns)
            .set({ llmUsage: addLlmCall(previous, call) })
            .where(eq(contentRuns.id, id))
            .returning();
          if (updated === undefined) {
            throw new AppError("CONTENT_RUN_NOT_FOUND", `No existe la corrida de contenido ${id}`);
          }
          return toContentRun(updated);
        }),
      );
    },

    sumLlmCost({ from, to, brokerId }) {
      return withDbErrors(async () => {
        // Las corridas de avisos y de posts (el corredor del que exista, ADR-0029) y los planes de
        // ideas (ADR-0030, punto 6), juntos, y después la suma por corredor.
        const owner = sql<string>`coalesce(${listings.brokerId}, ${posts.brokerId})`;
        const runSpend = db
          .select({ brokerId: owner.as("broker_id"), llmUsage: contentRuns.llmUsage })
          .from(contentRuns)
          .leftJoin(listings, eq(listings.id, contentRuns.listingId))
          .leftJoin(posts, eq(posts.id, contentRuns.postId))
          .where(
            and(
              isNotNull(contentRuns.llmUsage),
              gte(contentRuns.createdAt, from),
              lt(contentRuns.createdAt, to),
            ),
          );
        const planSpend = db
          .select({ brokerId: planRuns.brokerId, llmUsage: planRuns.llmUsage })
          .from(planRuns)
          .where(
            and(
              isNotNull(planRuns.llmUsage),
              gte(planRuns.createdAt, from),
              lt(planRuns.createdAt, to),
            ),
          );
        const spend = runSpend.unionAll(planSpend).as("spend");
        const rows = await db
          .select({
            brokerId: spend.brokerId,
            costUsd: sql<string>`coalesce(sum((${spend.llmUsage}->>'costUsd')::numeric), 0)`,
            runs: sql<number>`count(*)::int`,
          })
          .from(spend)
          .where(
            and(
              isNotNull(spend.brokerId),
              brokerId === undefined ? undefined : eq(spend.brokerId, brokerId),
            ),
          )
          .groupBy(spend.brokerId);
        return rows.map((row) => ({
          brokerId: row.brokerId,
          costUsd: Number(row.costUsd),
          runs: Number(row.runs),
        }));
      });
    },
  };
}
