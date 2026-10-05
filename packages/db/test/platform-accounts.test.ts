import { createSecretBox } from "@agentsales/config";
import {
  createInMemoryBrokerRepository,
  createInMemoryPlatformAccountRepository,
} from "@agentsales/core/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrokerRepository } from "../src/repositories/brokers.js";
import { createPlatformAccountRepository } from "../src/repositories/platform-accounts.js";
import { platformAccounts } from "../src/schema.js";
import { brokerData } from "./import-repositories.contract.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";
import {
  connectedAccount,
  platformAccountRepositoryContract,
} from "./platform-accounts.contract.js";

const MISSING_UUID = "00000000-0000-0000-0000-000000000000";
const APP_KEY = "k".repeat(32);

const databases: TestDatabase[] = [];
afterAll(async () => {
  await Promise.all(databases.map((database) => database.close()));
});

async function pgliteRepositories(appKey = APP_KEY) {
  const database = await createTestDatabase();
  databases.push(database);
  const { db } = database;
  return {
    db,
    brokers: createBrokerRepository(db),
    accounts: createPlatformAccountRepository(db, { secretBox: createSecretBox(appKey) }),
    missingId: MISSING_UUID,
  };
}

platformAccountRepositoryContract("en memoria", async () => {
  const brokers = createInMemoryBrokerRepository();
  return {
    brokers,
    accounts: createInMemoryPlatformAccountRepository({ brokers }),
    missingId: MISSING_UUID,
  };
});

platformAccountRepositoryContract("Drizzle sobre PGlite", () => pgliteRepositories());

describe("cuentas conectadas · cifrado en la base (PGlite)", () => {
  let repos: Awaited<ReturnType<typeof pgliteRepositories>>;
  let brokerId: string;
  beforeAll(async () => {
    repos = await pgliteRepositories();
    brokerId = (await repos.brokers.create(brokerData("cuentas-cifrado"))).id;
  });

  const rawRow = async (id: string) => {
    const [row] = await repos.db.select().from(platformAccounts).where(eq(platformAccounts.id, id));
    return row;
  };

  it("la columna guarda el cifrado, nunca el token", async () => {
    const input = connectedAccount(brokerId);
    const account = await repos.accounts.upsertConnected(input);
    const row = await rawRow(account.id);

    expect(row?.credentialsEncrypted).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(input.credentials.accessToken);
  });

  it("un cifrado copiado a otra cuenta no se descifra (AAD): CREDENTIALS_UNREADABLE", async () => {
    const first = await repos.accounts.upsertConnected(connectedAccount(brokerId));
    const second = await repos.accounts.upsertConnected(connectedAccount(brokerId));
    const stolen = (await rawRow(first.id))?.credentialsEncrypted ?? null;
    await repos.db
      .update(platformAccounts)
      .set({ credentialsEncrypted: stolen })
      .where(eq(platformAccounts.id, second.id));

    await expect(repos.accounts.getCredentials(second.id)).rejects.toMatchObject({
      code: "CREDENTIALS_UNREADABLE",
      retriable: false,
    });
    expect((await repos.accounts.getCredentials(first.id)).accessToken).toMatch(/^IGAA/);
  });

  it("con otra APP_ENCRYPTION_KEY no se descifra: CREDENTIALS_UNREADABLE sin el token en el error", async () => {
    const input = connectedAccount(brokerId);
    const account = await repos.accounts.upsertConnected(input);
    const otherKey = createPlatformAccountRepository(repos.db, {
      secretBox: createSecretBox("z".repeat(32)),
    });

    const error = await otherKey.getCredentials(account.id).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CREDENTIALS_UNREADABLE" });
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error as object))).not.toContain(
      input.credentials.accessToken,
    );
  });

  it("un cifrado válido con otra forma (no { accessToken }) es CREDENTIALS_UNREADABLE", async () => {
    const account = await repos.accounts.upsertConnected(connectedAccount(brokerId));
    const sealed = createSecretBox(APP_KEY).encrypt(
      JSON.stringify({ otra: "forma" }),
      `instagram:${account.externalAccountId}`,
    );
    await repos.db
      .update(platformAccounts)
      .set({ credentialsEncrypted: sealed })
      .where(eq(platformAccounts.id, account.id));

    await expect(repos.accounts.getCredentials(account.id)).rejects.toMatchObject({
      code: "CREDENTIALS_UNREADABLE",
    });
  });

  it("una fila con meta corrupta es PLATFORM_ACCOUNT_ROW_INVALID, no un ZodError", async () => {
    const account = await repos.accounts.upsertConnected(connectedAccount(brokerId));
    await repos.db
      .update(platformAccounts)
      .set({ meta: ["no", "es", "objeto"] })
      .where(eq(platformAccounts.id, account.id));

    await expect(repos.accounts.get(account.id)).rejects.toMatchObject({
      code: "PLATFORM_ACCOUNT_ROW_INVALID",
      retriable: false,
    });
  });
});
