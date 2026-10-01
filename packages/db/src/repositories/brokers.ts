import {
  AppError,
  type Broker,
  type BrokerData,
  type BrokerRepository,
  brokerSchema,
} from "@agentsales/core";
import { eq } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { isUniqueViolation, withDbErrors } from "../errors.js";
import { brokers } from "../schema.js";

const SLUG_UNIQUE = "brokers_slug_unique";

function toBroker(row: typeof brokers.$inferSelect): Broker {
  return brokerSchema.parse({
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
  });
}

/** Columnas que escribe la hoja Corredor; nunca `logo_media_id` ni `auto_publish`. */
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
    findBySlug(slug) {
      return withDbErrors(async () => {
        const [row] = await db.select().from(brokers).where(eq(brokers.slug, slug));
        return row === undefined ? null : toBroker(row);
      });
    },

    async create(data) {
      try {
        return await withDbErrors(async () => {
          const [row] = await db.insert(brokers).values(columnsOf(data)).returning();
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
  };
}
