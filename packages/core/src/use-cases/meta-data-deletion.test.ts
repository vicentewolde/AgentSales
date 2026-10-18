import { describe, expect, it } from "vitest";
import {
  createFakeSecretTokens,
  createInMemoryMetaDeletionRepository,
  createInMemoryPlatformAccountRepository,
  createInMemoryPublicationRepository,
} from "../testing/index.js";
import {
  getMetaDeletionRequest,
  handleMetaDataDeletion,
  handleMetaDeauthorize,
} from "./meta-data-deletion.js";

// F8-T17 (spec F8 §4.11, D18): las vueltas de Meta. Lo que se borra lo prueba el contrato del
// repositorio (`packages/db/test/meta-deletion.test.ts`, en memoria y en PGlite).

const RECEIVED = new Date("2026-10-18T15:00:00.000Z");
const IG_USER = "17841400000000001";

async function setup() {
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const publications = createInMemoryPublicationRepository();
  const metaDeletion = createInMemoryMetaDeletionRepository({ platformAccounts, publications });
  const account = await platformAccounts.upsertConnected({
    brokerId: "broker-1",
    platform: "instagram",
    externalAccountId: IG_USER,
    displayName: "@corredora",
    tokenExpiresAt: null,
    meta: {},
    credentials: { accessToken: "IGAA-secreto" },
  });
  const deps = {
    metaDeletion,
    tokens: createFakeSecretTokens(),
    hashUserId: (id: string) => `hmac:${id}`,
    now: () => RECEIVED,
  };
  return { deps, metaDeletion, platformAccounts, account };
}

describe("las vueltas de Meta", () => {
  it("quitar la app desconecta la cuenta de ese usuario y cuenta cuántas", async () => {
    const t = await setup();
    expect(await handleMetaDeauthorize(t.deps, { instagramUserId: IG_USER })).toEqual({
      accounts: 1,
    });
    const after = await t.platformAccounts.get(t.account.id);
    expect(after).toMatchObject({
      status: "revoked",
      hasCredentials: false,
      displayName: "@corredora",
    });
    // Repetirlo no cambia nada.
    expect(await handleMetaDeauthorize(t.deps, { instagramUserId: IG_USER })).toEqual({
      accounts: 0,
    });
  });

  it("borrar los datos devuelve un código y guarda solo el hash del usuario", async () => {
    const t = await setup();
    const request = await handleMetaDataDeletion(t.deps, { instagramUserId: IG_USER });

    expect(request).toEqual({
      code: "token-1",
      status: "completed",
      receivedAt: RECEIVED,
      completedAt: RECEIVED,
      accountsAffected: 1,
    });
    expect(t.metaDeletion.storedUserIdHashes()).toEqual([`hmac:${IG_USER}`]);
    expect(await getMetaDeletionRequest(t.deps, "token-1")).toEqual(request);
  });

  it("un usuario desconocido recibe igual su código, sin borrar nada", async () => {
    const t = await setup();
    const request = await handleMetaDataDeletion(t.deps, { instagramUserId: "otro" });

    expect(request.accountsAffected).toBe(0);
    expect(await t.platformAccounts.get(t.account.id)).toMatchObject({
      status: "connected",
      externalAccountId: IG_USER,
    });
  });

  it("un código sin forma ni se busca; uno que no existe da null", async () => {
    const t = await setup();
    expect(await getMetaDeletionRequest(t.deps, "../otro")).toBeNull();
    expect(await getMetaDeletionRequest(t.deps, "x".repeat(65))).toBeNull();
    expect(await getMetaDeletionRequest(t.deps, "no-existe")).toBeNull();
  });
});
