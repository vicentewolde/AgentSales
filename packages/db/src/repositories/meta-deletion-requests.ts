import {
  ERASED_ACCOUNT_DISPLAY_NAME,
  erasedExternalAccountId,
  type MetaDeletionRepository,
  type MetaDeletionRequest,
} from "@agentsales/core";
import { and, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { withDbErrors } from "../errors.js";
import {
  metaDeletionRequests,
  platformAccounts,
  publicationEvents,
  publications,
} from "../schema.js";

type Row = typeof metaDeletionRequests.$inferSelect;

const toRequest = (row: Row): MetaDeletionRequest => ({
  code: row.code,
  // La columna es texto por si llega un borrado diferido; hoy solo se escribe `completed`.
  status: "completed",
  receivedAt: row.receivedAt,
  completedAt: row.completedAt,
  accountsAffected: row.accountsAffected,
});

/** Las cuentas de Instagram de ese usuario de Instagram (en cualquier corredor). */
const ofInstagramUser = (instagramUserId: string) =>
  and(
    eq(platformAccounts.platform, "instagram"),
    eq(platformAccounts.externalAccountId, instagramUserId),
  );

/** `MetaDeletionRepository` sobre Drizzle (spec F8 §4.11, T17). */
export function createMetaDeletionRepository(db: SchemaDatabase): MetaDeletionRepository {
  return {
    async deauthorizeInstagramUser(instagramUserId) {
      return withDbErrors(async () => {
        const changed = await db
          .update(platformAccounts)
          .set({ status: "revoked", credentialsEncrypted: null })
          .where(
            and(
              ofInstagramUser(instagramUserId),
              or(
                ne(platformAccounts.status, "revoked"),
                isNotNull(platformAccounts.credentialsEncrypted),
              ),
            ),
          )
          .returning({ id: platformAccounts.id });
        return changed.length;
      });
    },

    async eraseInstagramUser(input) {
      return withDbErrors(() =>
        db.transaction(async (tx) => {
          // Las filas quedan tomadas: un refresco o una conexión que se cruce espera el borrado.
          const accounts = await tx
            .select({ id: platformAccounts.id })
            .from(platformAccounts)
            .where(ofInstagramUser(input.instagramUserId))
            .for("update");
          const accountIds = accounts.map(({ id }) => id);
          if (accountIds.length > 0) {
            const erased = await tx
              .update(publications)
              .set({ externalId: null, externalUrl: null, progress: null })
              .where(inArray(publications.platformAccountId, accountIds))
              .returning({ id: publications.id });
            const publicationIds = erased.map(({ id }) => id);
            if (publicationIds.length > 0) {
              // Lo enviado en cada intento guarda el nombre de la cuenta: se borra solo ese dato.
              await tx
                .update(publicationEvents)
                .set({
                  payload: sql`jsonb_set(${publicationEvents.payload}, '{sent,account,displayName}', '""'::jsonb)`,
                })
                .where(
                  and(
                    inArray(publicationEvents.publicationId, publicationIds),
                    eq(publicationEvents.type, "publish_attempt"),
                    sql`jsonb_typeof(${publicationEvents.payload} #> '{sent,account}') = 'object'`,
                  ),
                );
              await tx.insert(publicationEvents).values(
                publicationIds.map((publicationId) => ({
                  publicationId,
                  type: "data_deleted",
                  actor: "system",
                  payload: { confirmationCode: input.code },
                })),
              );
            }
            for (const id of accountIds) {
              await tx
                .update(platformAccounts)
                .set({
                  status: "revoked",
                  credentialsEncrypted: null,
                  externalAccountId: erasedExternalAccountId(id),
                  displayName: ERASED_ACCOUNT_DISPLAY_NAME,
                  meta: {},
                  tokenExpiresAt: null,
                })
                .where(eq(platformAccounts.id, id));
            }
          }
          const [row] = await tx
            .insert(metaDeletionRequests)
            .values({
              code: input.code,
              metaUserIdHash: input.instagramUserIdHash,
              receivedAt: input.receivedAt,
              status: "completed",
              completedAt: input.receivedAt,
              accountsAffected: accountIds.length,
            })
            .returning();
          if (row === undefined) throw new Error("no se anotó el pedido de borrado");
          return toRequest(row);
        }),
      );
    },

    async getByCode(code) {
      const [row] = await withDbErrors(() =>
        db.select().from(metaDeletionRequests).where(eq(metaDeletionRequests.code, code)),
      );
      return row === undefined ? null : toRequest(row);
    },
  };
}
