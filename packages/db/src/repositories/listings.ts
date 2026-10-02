import {
  AppError,
  type Listing,
  type ListingImportData,
  type ListingImportRecord,
  type ListingRepository,
  listingSchema,
} from "@agentsales/core";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { isUniqueViolation, withDbErrors } from "../errors.js";
import { listings } from "../schema.js";

const EXTERNAL_REF_UNIQUE = "listings_broker_id_external_ref_unique";

const recordColumns = {
  id: listings.id,
  externalRef: listings.externalRef,
  status: listings.status,
  sourceHash: listings.sourceHash,
};

/** `price_amount` es `numeric(14,2)`: Drizzle lo lee y lo escribe como texto. */
const toPrice = (amount: number) => amount.toFixed(2);

/**
 * Fila → entidad. Una fila que no calza con `listingSchema` (un `attributes` editado a mano, por
 * ejemplo) es `LISTING_ROW_INVALID`, no reintentable, y no un `ZodError`.
 */
function toListing(row: typeof listings.$inferSelect): Listing {
  const parsed = listingSchema.safeParse({
    id: row.id,
    brokerId: row.brokerId,
    externalRef: row.externalRef,
    category: row.category,
    status: row.status,
    closeReason: row.closeReason,
    operation: row.operation,
    propertyType: row.propertyType,
    region: row.region,
    comuna: row.comuna,
    address: row.address,
    unitNumber: row.unitNumber,
    showExactAddress: row.showExactAddress,
    priceAmount: Number(row.priceAmount),
    priceCurrency: row.priceCurrency,
    highlights: row.highlights,
    internalNotes: row.internalNotes,
    attributes: row.attributes,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  if (!parsed.success) {
    throw new AppError("LISTING_ROW_INVALID", `El aviso ${row.id} tiene datos inválidos`, {
      details: { id: row.id, issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

/** Columnas que escribe la importación; nunca `status` (es del operador y de la ingesta, T07). */
function columnsOf(data: ListingImportData) {
  return {
    operation: data.operation,
    propertyType: data.propertyType,
    region: data.region,
    comuna: data.comuna,
    address: data.address,
    unitNumber: data.unitNumber,
    showExactAddress: data.showExactAddress,
    priceAmount: toPrice(data.priceAmount),
    priceCurrency: data.priceCurrency,
    highlights: data.highlights,
    internalNotes: data.internalNotes,
    attributes: data.attributes,
    sourceHash: data.sourceHash,
  };
}

/** `ListingRepository` sobre Drizzle (node-postgres en las apps, PGlite en los tests). */
export function createListingRepository(db: SchemaDatabase): ListingRepository {
  return {
    async findByExternalRefs(brokerId, externalRefs) {
      if (externalRefs.length === 0) return [];
      return withDbErrors(() =>
        db
          .select(recordColumns)
          .from(listings)
          .where(
            and(eq(listings.brokerId, brokerId), inArray(listings.externalRef, [...externalRefs])),
          ),
      );
    },

    async create(listing) {
      try {
        return await withDbErrors(async (): Promise<ListingImportRecord> => {
          const [row] = await db
            .insert(listings)
            .values({
              ...columnsOf(listing),
              brokerId: listing.brokerId,
              externalRef: listing.externalRef,
              category: listing.category,
              source: listing.source,
              status: "draft",
            })
            .returning(recordColumns);
          if (row === undefined) throw new AppError("LISTING_WRITE_FAILED", "No se creó el aviso");
          return row;
        });
      } catch (error) {
        if (isUniqueViolation(error, EXTERNAL_REF_UNIQUE)) {
          // Dos intentos del job solapados: el reintento lo reclasifica como `skipped` o `updated`.
          throw new AppError("LISTING_CONFLICT", `Ya existe el aviso ${listing.externalRef}`, {
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
          .update(listings)
          .set(columnsOf(data))
          .where(eq(listings.id, id))
          .returning(recordColumns);
        if (row === undefined) throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${id}`);
        return row;
      });
    },

    list(filters = {}) {
      return withDbErrors(async () => {
        const conditions: SQL[] = [];
        if (filters.status !== undefined) conditions.push(eq(listings.status, filters.status));
        if (filters.operation !== undefined) {
          conditions.push(eq(listings.operation, filters.operation));
        }
        if (filters.comuna !== undefined) conditions.push(eq(listings.comuna, filters.comuna));
        if (filters.externalRef !== undefined) {
          conditions.push(eq(listings.externalRef, filters.externalRef));
        }
        const rows = await db
          .select()
          .from(listings)
          .where(and(...conditions))
          .orderBy(desc(listings.updatedAt), desc(listings.id));
        return rows.map(toListing);
      });
    },

    get(id) {
      return withDbErrors(async () => {
        const [row] = await db.select().from(listings).where(eq(listings.id, id));
        return row === undefined ? null : toListing(row);
      });
    },

    changeStatus(id, from, to) {
      return withDbErrors(async () => {
        const updated = await db
          .update(listings)
          .set({ status: to })
          .where(and(eq(listings.id, id), eq(listings.status, from)))
          .returning({ id: listings.id });
        return updated.length > 0;
      });
    },

    promoteToReady(id) {
      return withDbErrors(async () => {
        // Condicional: solo desde `draft`, así no pisa `paused`, `archived`, `active` ni `closed`.
        const updated = await db
          .update(listings)
          .set({ status: "ready" })
          .where(and(eq(listings.id, id), eq(listings.status, "draft")))
          .returning({ id: listings.id });
        return updated.length > 0;
      });
    },
  };
}
