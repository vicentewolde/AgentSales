import {
  ALL_SCOPE,
  AppError,
  type Broker,
  type BrokerData,
  type BrokerRepository,
  brokerSchema,
  normalizeLlmMonthlyCap,
  scopedBrokerId,
} from "@agentsales/core";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { isUniqueViolation, withDbErrors } from "../errors.js";
import { brokers, media } from "../schema.js";

const SLUG_UNIQUE = "brokers_slug_unique";

/**
 * Fila → entidad. Una fila que no calza con `brokerSchema` (por ejemplo, un `fixed_hashtags`
 * editado a mano con un `NULL`) es `BROKER_ROW_INVALID`, no reintentable, y no un `ZodError`.
 */
function toBroker(row: typeof brokers.$inferSelect): Broker {
  const parsed = brokerSchema.safeParse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    brandName: row.brandName,
    logoMediaId: row.logoMediaId,
    primaryColor: row.primaryColor,
    secondaryColor: row.secondaryColor,
    whatsapp: row.whatsapp,
    email: row.email,
    instagramHandle: row.instagramHandle,
    website: row.website,
    tone: row.tone,
    fixedHashtags: row.fixedHashtags,
    autoPublish: row.autoPublish,
    operatorOwned: row.operatorOwned,
    liveEnabled: row.liveEnabled,
    // `numeric` llega como texto: a número (dos decimales).
    llmMonthlyCapUsd: row.llmMonthlyCapUsd === null ? null : Number(row.llmMonthlyCapUsd),
    kind: row.kind,
  });
  if (!parsed.success) {
    throw new AppError("BROKER_ROW_INVALID", `El corredor ${row.slug} tiene datos inválidos`, {
      details: { id: row.id, issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

/** Columnas que escribe la hoja Corredor; nunca `logo_media_id`, `auto_publish`, `live_enabled` ni `kind`. */
function columnsOf(data: BrokerData) {
  return {
    slug: data.slug,
    name: data.name,
    brandName: data.brandName,
    primaryColor: data.primaryColor,
    secondaryColor: data.secondaryColor,
    whatsapp: data.whatsapp,
    email: data.email,
    instagramHandle: data.instagramHandle,
    website: data.website,
    tone: data.tone,
    fixedHashtags: data.fixedHashtags,
  };
}

/** `BrokerRepository` sobre Drizzle (node-postgres en las apps, PGlite en los tests). */
export function createBrokerRepository(db: SchemaDatabase): BrokerRepository {
  return {
    list(scope = ALL_SCOPE) {
      return withDbErrors(async () => {
        // Sin mayúsculas y por bytes ("C"): el mismo orden que el doble en memoria, sea cual sea la
        // collation de la base.
        const brokerId = scopedBrokerId(scope);
        const rows = await db
          .select()
          .from(brokers)
          .where(brokerId === undefined ? undefined : eq(brokers.id, brokerId))
          .orderBy(sql`lower(${brokers.brandName}) collate "C"`, asc(brokers.id));
        return rows.map(toBroker);
      });
    },

    findById(id) {
      return withDbErrors(async () => {
        const [row] = await db.select().from(brokers).where(eq(brokers.id, id));
        return row === undefined ? null : toBroker(row);
      });
    },

    findBySlug(slug) {
      return withDbErrors(async () => {
        const [row] = await db.select().from(brokers).where(eq(brokers.slug, slug));
        return row === undefined ? null : toBroker(row);
      });
    },

    async create(data, options = {}) {
      try {
        return await withDbErrors(async () => {
          const [row] = await db
            .insert(brokers)
            .values({
              ...columnsOf(data),
              ...(options.kind === undefined ? {} : { kind: options.kind }),
            })
            .returning();
          if (row === undefined)
            throw new AppError("BROKER_WRITE_FAILED", "No se creó el corredor");
          return toBroker(row);
        });
      } catch (error) {
        if (isUniqueViolation(error, SLUG_UNIQUE)) {
          // Dos intentos del job solapados: el reintento lo encuentra y sale `unchanged`.
          throw new AppError("BROKER_CONFLICT", `Ya existe el corredor ${data.slug}`, {
            retriable: true,
            cause: error,
          });
        }
        throw error;
      }
    },

    update(id, data) {
      return withDbErrors(async () => {
        const [row] = await db
          .update(brokers)
          .set(columnsOf(data))
          .where(eq(brokers.id, id))
          .returning();
        if (row === undefined)
          throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${id}`);
        return toBroker(row);
      });
    },

    setLogo(id, mediaId) {
      return withDbErrors(() =>
        db.transaction(async (tx) => {
          const [broker] = await tx
            .select({ id: brokers.id })
            .from(brokers)
            .where(eq(brokers.id, id));
          if (broker === undefined) {
            throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${id}`);
          }
          // Sin esto, un medio inexistente sería un 23503 (FK) genérico, y uno de otro corredor
          // o de un aviso pasaría sin error.
          const [logo] = await tx
            .select({ id: media.id })
            .from(media)
            .where(
              and(
                eq(media.id, mediaId),
                eq(media.brokerId, id),
                isNull(media.listingId),
                // Desde F9 un medio sin aviso puede ser de un post (ADR-0029): ese no es un logo.
                isNull(media.postId),
                eq(media.role, "original"),
              ),
            );
          if (logo === undefined) {
            throw new AppError("MEDIA_NOT_FOUND", `El medio ${mediaId} no es un logo del corredor`);
          }
          await tx.update(brokers).set({ logoMediaId: mediaId }).where(eq(brokers.id, id));
        }),
      );
    },

    setSettings(id, { operatorOwned, llmMonthlyCapUsd }) {
      return withDbErrors(async () => {
        const set: Partial<typeof brokers.$inferInsert> = {};
        if (operatorOwned !== undefined) set.operatorOwned = operatorOwned;
        if (llmMonthlyCapUsd !== undefined) {
          const cap = normalizeLlmMonthlyCap(llmMonthlyCapUsd);
          set.llmMonthlyCapUsd = cap === null ? null : cap.toFixed(2);
        }
        const [row] =
          Object.keys(set).length === 0
            ? await db.select().from(brokers).where(eq(brokers.id, id))
            : await db.update(brokers).set(set).where(eq(brokers.id, id)).returning();
        if (row === undefined)
          throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${id}`);
        return toBroker(row);
      });
    },

    setLiveEnabled(id, liveEnabled) {
      return withDbErrors(async () => {
        const [row] = await db
          .update(brokers)
          .set({ liveEnabled })
          .where(eq(brokers.id, id))
          .returning();
        if (row === undefined)
          throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${id}`);
        return toBroker(row);
      });
    },

    setAutoPublish(id, autoPublish) {
      return withDbErrors(async () => {
        const [row] = await db
          .update(brokers)
          .set({ autoPublish })
          .where(eq(brokers.id, id))
          .returning();
        if (row === undefined)
          throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${id}`);
        return toBroker(row);
      });
    },
  };
}
