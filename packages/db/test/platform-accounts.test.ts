import { createSecretBox } from "@agentsales/config";
import { refreshAccountToken } from "@agentsales/core";
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

  it("el refresco (F3-T14) guarda el token nuevo cifrado, el vencimiento y la meta mezclada", async () => {
    const now = new Date("2026-10-06T12:00:00Z");
    const input = connectedAccount(brokerId, {
      tokenExpiresAt: new Date("2026-10-26T12:00:00Z"),
      meta: {
        accountType: "BUSINESS",
        permissions: null,
        connectedAt: "2026-08-07T12:00:00.000Z",
        tokenRefreshedAt: null,
        tokenExpiryEstimated: true,
      },
    });
    const account = await repos.accounts.upsertConnected(input);
    const before = await rawRow(account.id);
    const newToken = "IGAA-token-refrescado-en-pglite";

    const result = await refreshAccountToken(
      {
        platformAccounts: repos.accounts,
        instagram: {
          refresh: async (accessToken) => {
            expect(accessToken).toBe(input.credentials.accessToken);
            return { accessToken: newToken, expiresAt: new Date("2026-12-05T12:00:00Z") };
          },
        },
        now: () => now,
      },
      { accountId: account.id },
    );

    expect(result.outcome).toBe("refreshed");
    const row = await rawRow(account.id);
    expect(row?.credentialsEncrypted).toMatch(/^v1\./);
    expect(row?.credentialsEncrypted).not.toBe(before?.credentialsEncrypted);
    expect(JSON.stringify(row)).not.toContain(newToken);
    expect(row?.tokenExpiresAt).toEqual(new Date("2026-12-05T12:00:00Z"));
    expect(row?.meta).toEqual({
      accountType: "BUSINESS",
      permissions: null,
      connectedAt: "2026-08-07T12:00:00.000Z",
      tokenRefreshedAt: now.toISOString(),
      tokenExpiryEstimated: false,
    });
    expect(await repos.accounts.getCredentials(account.id)).toEqual({ accessToken: newToken });
  });

  it("la columna guarda el cifrado, nunca el token", async () => {
    const input = connectedAccount(brokerId);
    const account = await repos.accounts.upsertConnected(input);
    const row = await rawRow(account.id);

    expect(row?.credentialsEncrypted).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(input.credentials.accessToken);
  });

  it("la columna tampoco guarda el token de renovar de Mercado Libre", async () => {
    const input = connectedAccount(brokerId, {
      platform: "portal_inmobiliario",
      credentials: { accessToken: "APP_USR-crudo-1", refreshToken: "TG-crudo-1" },
    });
    const account = await repos.accounts.upsertConnected(input);
    const row = await rawRow(account.id);

    expect(row?.credentialsEncrypted).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain("TG-crudo-1");
    expect(JSON.stringify(row)).not.toContain("APP_USR-crudo-1");
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

  it("la misma cuenta externa en otro corredor no comparte cifrado (la AAD lleva el corredor)", async () => {
    const otherBroker = (await repos.brokers.create(brokerData("cuentas-cifrado-otro"))).id;
    const input = connectedAccount(brokerId);
    const mine = await repos.accounts.upsertConnected(input);
    const theirs = await repos.accounts.upsertConnected({ ...input, brokerId: otherBroker });
    const stolen = (await rawRow(mine.id))?.credentialsEncrypted ?? null;
    await repos.db
      .update(platformAccounts)
      .set({ credentialsEncrypted: stolen })
      .where(eq(platformAccounts.id, theirs.id));

    await expect(repos.accounts.getCredentials(theirs.id)).rejects.toMatchObject({
      code: "CREDENTIALS_UNREADABLE",
    });
  });

  it("desconectar deja la columna en null", async () => {
    const account = await repos.accounts.upsertConnected(connectedAccount(brokerId));
    await repos.accounts.disconnect(account.id);

    expect((await rawRow(account.id))?.credentialsEncrypted).toBeNull();
  });

  it("updateToken reemplaza una meta guardada que no es objeto, en vez de concatenarla", async () => {
    const account = await repos.accounts.upsertConnected(connectedAccount(brokerId));
    await repos.db
      .update(platformAccounts)
      .set({ meta: ["corrupta"] })
      .where(eq(platformAccounts.id, account.id));

    const updated = await repos.accounts.updateToken(account.id, {
      credentials: { accessToken: "IGAA-nuevo" },
      tokenExpiresAt: null,
      meta: { tokenRefreshedAt: "2026-10-05T12:00:00.000Z" },
    });

    expect(updated.meta).toEqual({ tokenRefreshedAt: "2026-10-05T12:00:00.000Z" });
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
      `instagram:${brokerId}:${account.externalAccountId}`,
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

describe("cuentas conectadas · doble en memoria", () => {
  it("corruptCredentials simula un cifrado ilegible hasta la próxima reconexión", async () => {
    const brokers = createInMemoryBrokerRepository();
    const accounts = createInMemoryPlatformAccountRepository({ brokers });
    const brokerId = (await brokers.create(brokerData("cuentas-doble"))).id;
    const input = connectedAccount(brokerId);
    const account = await accounts.upsertConnected(input);

    accounts.corruptCredentials(account.id);
    await expect(accounts.getCredentials(account.id)).rejects.toMatchObject({
      code: "CREDENTIALS_UNREADABLE",
    });
    await accounts.upsertConnected(input);
    expect(await accounts.getCredentials(account.id)).toEqual(input.credentials);
  });
});
