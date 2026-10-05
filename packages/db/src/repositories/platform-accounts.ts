import {
  AppError,
  type Platform,
  type PlatformAccount,
  type PlatformAccountRepository,
  type PlatformCredentials,
  platformAccountSchema,
  platformCredentialsSchema,
  type SecretBox,
} from "@agentsales/core";
import { and, asc, eq, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { sqlStateOf, withDbErrors } from "../errors.js";
import { platformAccounts } from "../schema.js";

type Row = typeof platformAccounts.$inferSelect;

/**
 * Datos asociados del cifrado (AAD): atan las credenciales a su cuenta, así un cifrado copiado a
 * otra fila no se descifra. Se arma solo aquí. `external_account_id` no cambia en una fila (es parte
 * del único), así que la AAD tampoco.
 */
const credentialsAad = (platform: Platform, externalAccountId: string) =>
  `${platform}:${externalAccountId}`;

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

/**
 * `PlatformAccountRepository` sobre Drizzle (spec F3 §4.6). Cifra las credenciales con el
 * `SecretBox` que inyecta la app (`createSecretBox(APP_ENCRYPTION_KEY)`) y nunca las devuelve fuera
 * de `getCredentials`.
 */
export function createPlatformAccountRepository(
  db: SchemaDatabase,
  { secretBox }: { secretBox: SecretBox },
): PlatformAccountRepository {
  const seal = (platform: Platform, externalAccountId: string, credentials: PlatformCredentials) =>
    secretBox.encrypt(
      JSON.stringify(platformCredentialsSchema.parse(credentials)),
      credentialsAad(platform, externalAccountId),
    );

  /** Actualiza una fila; `ACCOUNT_NOT_FOUND` si no existe. */
  const update = (id: string, changes: Partial<typeof platformAccounts.$inferInsert>) =>
    withDbErrors(async () => {
      const [row] = await db
        .update(platformAccounts)
        .set(changes)
        .where(eq(platformAccounts.id, id))
        .returning();
      if (row === undefined) throw notFound(id);
      return toAccount(row);
    });

  const findRow = (id: string) =>
    withDbErrors(async () => {
      const [row] = await db.select().from(platformAccounts).where(eq(platformAccounts.id, id));
      return row;
    });

  return {
    async upsertConnected(account) {
      const values = {
        brokerId: account.brokerId,
        platform: account.platform,
        externalAccountId: account.externalAccountId,
        displayName: account.displayName,
        credentialsEncrypted: seal(
          account.platform,
          account.externalAccountId,
          account.credentials,
        ),
        tokenExpiresAt: account.tokenExpiresAt,
        status: "connected" as const,
        meta: account.meta,
      };
      try {
        return await withDbErrors(async () => {
          const [row] = await db
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
          return toAccount(row);
        });
      } catch (error) {
        // FK de `broker_id`: el corredor no existe.
        if (sqlStateOf(error) === "23503") {
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
      if (row.credentialsEncrypted === null) {
        throw new AppError("ACCOUNT_NOT_CONNECTED", "La cuenta no tiene credenciales: conéctala", {
          details: { accountId: id },
        });
      }
      const plaintext = secretBox.decrypt(
        row.credentialsEncrypted,
        credentialsAad(row.platform, row.externalAccountId),
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(plaintext);
      } catch {
        parsed = undefined;
      }
      const credentials = platformCredentialsSchema.safeParse(parsed);
      if (!credentials.success) {
        throw new AppError(
          "CREDENTIALS_UNREADABLE",
          "No se pudieron leer las credenciales guardadas: reconecta la cuenta",
          { details: { reason: "shape", accountId: id } },
        );
      }
      return credentials.data;
    },

    async updateToken(id, { credentials, tokenExpiresAt, meta }) {
      const row = await findRow(id);
      if (row === undefined) throw notFound(id);
      return update(id, {
        credentialsEncrypted: seal(row.platform, row.externalAccountId, credentials),
        tokenExpiresAt,
        // Mezcla en la base (`||` de jsonb): no pisa lo que otro escribió entre la lectura y esto.
        ...(meta === undefined
          ? {}
          : { meta: sql`${platformAccounts.meta} || ${JSON.stringify(meta)}::jsonb` }),
      });
    },

    markStatus(id, status) {
      return update(id, { status });
    },

    disconnect(id) {
      return update(id, { status: "revoked", credentialsEncrypted: null });
    },
  };
}
