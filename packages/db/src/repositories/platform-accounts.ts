import {
  AppError,
  checkCredentials,
  normalizeAccountMeta,
  type PlatformAccount,
  type PlatformAccountRepository,
  type PlatformCredentials,
  platformAccountSchema,
  platformCredentialsSchema,
  type SecretBox,
} from "@agentsales/core";
import { and, asc, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { isForeignKeyViolation, withDbErrors } from "../errors.js";
import { platformAccounts } from "../schema.js";

type Row = typeof platformAccounts.$inferSelect;

const BROKER_FK = "platform_accounts_broker_id_brokers_id_fk";

/**
 * Datos asociados del cifrado (AAD): atan las credenciales a su fila, así un cifrado copiado a otra
 * cuenta (también la misma cuenta externa en otro corredor) no se descifra. Se arma solo aquí.
 * Corredor, plataforma y cuenta externa son el único de la tabla y no cambian en una fila.
 */
const credentialsAad = (row: Pick<Row, "brokerId" | "platform" | "externalAccountId">) =>
  `${row.platform}:${row.brokerId}:${row.externalAccountId}`;

/** Fila → entidad, sin credenciales. Una fila que no calza es `PLATFORM_ACCOUNT_ROW_INVALID`. */
function toAccount(row: Row): PlatformAccount {
  const parsed = platformAccountSchema.safeParse({
    id: row.id,
    brokerId: row.brokerId,
    platform: row.platform,
    externalAccountId: row.externalAccountId,
    displayName: row.displayName,
    status: row.status,
    tokenExpiresAt: row.tokenExpiresAt,
    meta: row.meta,
    hasCredentials: row.credentialsEncrypted !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  if (!parsed.success) {
    throw new AppError(
      "PLATFORM_ACCOUNT_ROW_INVALID",
      `La cuenta ${row.id} tiene datos inválidos`,
      {
        details: { id: row.id, issues: parsed.error.issues },
      },
    );
  }
  return parsed.data;
}

const notFound = (id: string) =>
  new AppError("ACCOUNT_NOT_FOUND", `No existe la cuenta ${id}`, { details: { accountId: id } });

const notConnected = (id: string) =>
  new AppError("ACCOUNT_NOT_CONNECTED", "La cuenta no tiene credenciales: conéctala", {
    details: { accountId: id },
  });

const unreadable = (id: string) =>
  new AppError(
    "CREDENTIALS_UNREADABLE",
    "No se pudieron leer las credenciales guardadas: reconecta la cuenta",
    { details: { reason: "shape", accountId: id } },
  );

/**
 * `PlatformAccountRepository` sobre Drizzle (spec F3 §4.6). Cifra las credenciales con el
 * `SecretBox` que inyecta la app (`createSecretBox(APP_ENCRYPTION_KEY)` de config) y nunca las
 * devuelve fuera de `getCredentials`.
 */
export function createPlatformAccountRepository(
  db: SchemaDatabase,
  { secretBox }: { secretBox: SecretBox },
): PlatformAccountRepository {
  const seal = (
    owner: Pick<Row, "brokerId" | "platform" | "externalAccountId">,
    credentials: PlatformCredentials,
  ) => secretBox.encrypt(JSON.stringify(credentials), credentialsAad(owner));

  const findRow = (id: string) =>
    withDbErrors(async () => {
      const [row] = await db.select().from(platformAccounts).where(eq(platformAccounts.id, id));
      return row;
    });

  return {
    async upsertConnected(account, options = {}) {
      const credentials = checkCredentials(account.credentials);
      const meta = normalizeAccountMeta(account.meta);
      const values = {
        brokerId: account.brokerId,
        platform: account.platform,
        externalAccountId: account.externalAccountId,
        displayName: account.displayName,
        credentialsEncrypted: seal(account, credentials),
        tokenExpiresAt: account.tokenExpiresAt,
        status: "connected" as const,
        meta,
      };
      try {
        return await withDbErrors(() =>
          db.transaction(async (tx) => {
            const [row] = await tx
              .insert(platformAccounts)
              .values(values)
              .onConflictDoUpdate({
                target: [
                  platformAccounts.brokerId,
                  platformAccounts.platform,
                  platformAccounts.externalAccountId,
                ],
                set: {
                  displayName: values.displayName,
                  credentialsEncrypted: values.credentialsEncrypted,
                  tokenExpiresAt: values.tokenExpiresAt,
                  status: values.status,
                  meta: values.meta,
                  updatedAt: sql`now()`,
                },
              })
              .returning();
            if (row === undefined) throw new Error("upsert sin fila");
            if (options.revokeOthers) {
              // En la misma transacción: nunca quedan dos conectadas del corredor en la plataforma.
              await tx
                .update(platformAccounts)
                .set({ status: "revoked", credentialsEncrypted: null })
                .where(
                  and(
                    eq(platformAccounts.brokerId, row.brokerId),
                    eq(platformAccounts.platform, row.platform),
                    ne(platformAccounts.id, row.id),
                    ne(platformAccounts.status, "revoked"),
                  ),
                );
            }
            return toAccount(row);
          }),
        );
      } catch (error) {
        if (isForeignKeyViolation(error, BROKER_FK)) {
          throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${account.brokerId}`, {
            details: { brokerId: account.brokerId },
          });
        }
        throw error;
      }
    },

    async get(id) {
      const row = await findRow(id);
      return row === undefined ? null : toAccount(row);
    },

    list() {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(platformAccounts)
          .orderBy(asc(platformAccounts.createdAt), asc(platformAccounts.id));
        return rows.map(toAccount);
      });
    },

    listByBroker(brokerId, platform) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(platformAccounts)
          .where(
            and(
              eq(platformAccounts.brokerId, brokerId),
              platform === undefined ? undefined : eq(platformAccounts.platform, platform),
            ),
          )
          .orderBy(asc(platformAccounts.createdAt), asc(platformAccounts.id));
        return rows.map(toAccount);
      });
    },

    async getCredentials(id) {
      const row = await findRow(id);
      if (row === undefined) throw notFound(id);
      if (row.credentialsEncrypted === null) throw notConnected(id);
      const plaintext = secretBox.decrypt(row.credentialsEncrypted, credentialsAad(row));
      let parsed: unknown;
      try {
        parsed = JSON.parse(plaintext);
      } catch {
        throw unreadable(id);
      }
      const credentials = platformCredentialsSchema.safeParse(parsed);
      if (!credentials.success) throw unreadable(id);
      return credentials.data;
    },

    async updateToken(id, { credentials, tokenExpiresAt, meta }) {
      const checked = checkCredentials(credentials);
      const patch = normalizeAccountMeta(meta);
      const row = await findRow(id);
      if (row === undefined) throw notFound(id);
      const [updated] = await withDbErrors(() =>
        // Condicional: un refresco que se cruza con una desconexión o un vencimiento no revive la
        // cuenta. La mezcla de `meta` es en la base (`||`), a un nivel, y reemplaza una `meta`
        // guardada que no sea objeto.
        db
          .update(platformAccounts)
          .set({
            credentialsEncrypted: seal(row, checked),
            tokenExpiresAt,
            meta: sql`(CASE WHEN jsonb_typeof(${platformAccounts.meta}) = 'object' THEN ${platformAccounts.meta} ELSE '{}'::jsonb END) || ${JSON.stringify(patch)}::jsonb`,
          })
          .where(
            and(
              eq(platformAccounts.id, id),
              eq(platformAccounts.status, "connected"),
              isNotNull(platformAccounts.credentialsEncrypted),
            ),
          )
          .returning(),
      );
      if (updated === undefined) throw notConnected(id);
      return toAccount(updated);
    },

    async changeStatus(id, from, to) {
      const changed = await withDbErrors(() =>
        db
          .update(platformAccounts)
          .set({ status: to })
          .where(and(eq(platformAccounts.id, id), eq(platformAccounts.status, from)))
          .returning({ id: platformAccounts.id }),
      );
      if (changed.length > 0) return true;
      if ((await findRow(id)) === undefined) throw notFound(id);
      return false;
    },

    async disconnect(id) {
      const [row] = await withDbErrors(() =>
        db
          .update(platformAccounts)
          .set({ status: "revoked", credentialsEncrypted: null })
          .where(eq(platformAccounts.id, id))
          .returning(),
      );
      if (row === undefined) throw notFound(id);
      return toAccount(row);
    },
  };
}
