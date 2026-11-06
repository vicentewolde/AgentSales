import type { LeadWebhookKeyRepository } from "@agentsales/core";
import { eq, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { withDbErrors } from "../errors.js";
import { leadWebhookKeys } from "../schema.js";

/** `LeadWebhookKeyRepository` sobre Drizzle (F10-T04): un hash por corredor, rotar lo reemplaza. */
export function createLeadWebhookKeyRepository(db: SchemaDatabase): LeadWebhookKeyRepository {
  return {
    async getHash(brokerId) {
      const [row] = await withDbErrors(() =>
        db
          .select({ secretHash: leadWebhookKeys.secretHash })
          .from(leadWebhookKeys)
          .where(eq(leadWebhookKeys.brokerId, brokerId)),
      );
      return row?.secretHash ?? null;
    },
    async setHash(brokerId, secretHash) {
      await withDbErrors(() =>
        db
          .insert(leadWebhookKeys)
          .values({ brokerId, secretHash })
          .onConflictDoUpdate({
            target: leadWebhookKeys.brokerId,
            set: { secretHash, updatedAt: sql`now()` },
          }),
      );
    },
  };
}
