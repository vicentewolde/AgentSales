import { AppError, type ListingLock, type SecretBox } from "@agentsales/core";
import { eq } from "drizzle-orm";
import type { SchemaDatabase } from "./client.js";
import { withDbErrors } from "./errors.js";
import { createBrokerRepository } from "./repositories/brokers.js";
import { createContentRunRepository } from "./repositories/content-runs.js";
import { createContentRepository } from "./repositories/contents.js";
import { createListingRepository } from "./repositories/listings.js";
import { createMediaRepository } from "./repositories/media.js";
import { createPlatformAccountRepository } from "./repositories/platform-accounts.js";
import { createPublicationRepository } from "./repositories/publications.js";
import { listings } from "./schema.js";

/**
 * Candado por aviso sobre Postgres (ADR-0014, spec F3 §4.2): una transacción que bloquea la fila
 * del aviso con `FOR NO KEY UPDATE` (como `MediaRepository.arrange`) y entrega a `fn` repositorios
 * atados a esa transacción. Las transacciones propias de los repositorios (`arrange`,
 * `upsertDerivative`, `markSucceeded`, las de publicaciones) pasan a ser savepoints. Si `fn` falla,
 * se deshace todo. Dos `run` del mismo aviso se esperan; los de avisos distintos no.
 */
export function createListingLock(
  db: SchemaDatabase,
  { secretBox }: { secretBox: SecretBox },
): ListingLock {
  return {
    run(listingId, fn) {
      return withDbErrors(() =>
        db.transaction(async (tx) => {
          const [row] = await tx
            .select({ id: listings.id })
            .from(listings)
            .where(eq(listings.id, listingId))
            .for("no key update");
          if (row === undefined) {
            throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${listingId}`, {
              details: { listingId },
            });
          }
          return fn({
            brokers: createBrokerRepository(tx),
            listings: createListingRepository(tx),
            media: createMediaRepository(tx),
            contentRuns: createContentRunRepository(tx),
            contents: createContentRepository(tx),
            publications: createPublicationRepository(tx),
            platformAccounts: createPlatformAccountRepository(tx, { secretBox }),
          });
        }),
      );
    },
  };
}
