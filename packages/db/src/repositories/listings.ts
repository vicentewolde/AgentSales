import {
  AppError,
  type ListingImportData,
  type ListingImportRecord,
  type ListingRepository,
} from "@agentsales/core";
import { and, eq, inArray } from "drizzle-orm";
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
  };
}
