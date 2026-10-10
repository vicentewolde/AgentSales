import { describe, expect, it } from "vitest";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryJobQueue,
  createInMemoryPlatformAccountRepository,
  createInMemoryPublicationRepository,
} from "../testing/index.js";
import {
  connectMarketplaceAccount,
  recordMarketplaceLoginError,
} from "./connect-marketplace-account.js";
import { disconnectAccount } from "./disconnect-account.js";

const NOW = new Date("2026-10-10T12:00:00Z");

function setup() {
  const broker = contentBrokerFixture();
  const brokers = createInMemoryBrokerRepository([broker]);
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const publications = createInMemoryPublicationRepository();
  const queue = createInMemoryJobQueue();
  const deps = { brokers, platformAccounts, now: () => NOW };
  return { broker, platformAccounts, publications, queue, deps };
}

describe("connectMarketplaceAccount (spec F5 §4.2)", () => {
  it("conecta sin credenciales, con el id de la sesión y el nombre del corredor", async () => {
    const { broker, platformAccounts, deps } = setup();

    const account = await connectMarketplaceAccount(deps, {
      brokerId: broker.id,
      userId: "100012345678901",
    });

    expect(account).toMatchObject({
      platform: "fb_marketplace",
      externalAccountId: "100012345678901",
      displayName: `Facebook de ${broker.name}`,
      status: "connected",
      tokenExpiresAt: null,
      hasCredentials: false,
      meta: {
        userId: "100012345678901",
        connectedAt: NOW.toISOString(),
        sessionCheckedAt: NOW.toISOString(),
      },
    });
    expect(platformAccounts.storedCredentials(account.id)).toBeNull();
  });

  it("reconectar la misma cuenta la actualiza (y borra el último error); otra revoca la anterior", async () => {
    const { broker, platformAccounts, deps } = setup();
    const first = await connectMarketplaceAccount(deps, { brokerId: broker.id, userId: "1" });
    await recordMarketplaceLoginError(deps, {
      brokerId: broker.id,
      code: "MARKETPLACE_PROFILE_BUSY",
    });

    const again = await connectMarketplaceAccount(deps, {
      brokerId: broker.id,
      userId: "1",
      label: "  Mi Facebook  ",
    });
    expect(again.id).toBe(first.id);
    expect(again.displayName).toBe("Mi Facebook");
    expect(again.meta).not.toHaveProperty("lastLoginError");

    const other = await connectMarketplaceAccount(deps, { brokerId: broker.id, userId: "2" });
    expect(other.id).not.toBe(first.id);
    expect((await platformAccounts.get(first.id))?.status).toBe("revoked");
  });

  it("un id que no es numérico o un corredor que no existe no conectan nada", async () => {
    const { broker, platformAccounts, deps } = setup();
    await expect(
      connectMarketplaceAccount(deps, { brokerId: broker.id, userId: "abc" }),
    ).rejects.toMatchObject({ code: "MARKETPLACE_SESSION_ID_INVALID" });
    await expect(
      connectMarketplaceAccount(deps, { brokerId: "no-existe", userId: "1" }),
    ).rejects.toMatchObject({ code: "BROKER_NOT_FOUND" });
    expect(await platformAccounts.list()).toEqual([]);
  });

  it("el último error de inicio de sesión queda en la cuenta, si existe", async () => {
    const { broker, deps } = setup();
    await expect(
      recordMarketplaceLoginError(deps, { brokerId: broker.id, code: "X" }),
    ).resolves.toBeNull();
    await connectMarketplaceAccount(deps, { brokerId: broker.id, userId: "1" });

    const account = await recordMarketplaceLoginError(deps, {
      brokerId: broker.id,
      code: "MARKETPLACE_PROFILE_BUSY",
    });

    expect(account?.meta).toMatchObject({
      lastLoginError: { code: "MARKETPLACE_PROFILE_BUSY", at: NOW.toISOString() },
    });
    expect(account?.status).toBe("connected");
  });
});

describe("disconnectAccount · Marketplace (spec F5 §4.2)", () => {
  it("pide confirmación, cambia solo la base y encola el borrado del perfil", async () => {
    const { broker, publications, queue, platformAccounts, deps } = setup();
    const account = await connectMarketplaceAccount(deps, { brokerId: broker.id, userId: "1" });
    const disconnect = { platformAccounts, publications, queue };

    await expect(disconnectAccount(disconnect, { accountId: account.id })).rejects.toMatchObject({
      code: "DISCONNECT_NOT_CONFIRMED",
    });
    expect(queue.jobs).toEqual([]);

    const result = await disconnectAccount(disconnect, { accountId: account.id, confirmed: true });

    expect(result.status).toBe("revoked");
    expect(queue.jobs).toEqual([
      expect.objectContaining({
        name: "marketplace.profile",
        data: { brokerId: broker.id, action: "forget" },
      }),
    ]);
    // Repetirlo vuelve a encolar el borrado (idempotente: repara uno que falló).
    await disconnectAccount(disconnect, { accountId: account.id, confirmed: true });
    expect(queue.jobs).toHaveLength(2);
  });

  it("con un formulario esperando el clic final: MANUAL_CONFIRM_PENDING, sin cambiar nada", async () => {
    const { broker, publications, queue, platformAccounts, deps } = setup();
    const account = await connectMarketplaceAccount(deps, { brokerId: broker.id, userId: "1" });
    const waiting = await publications.create(
      {
        listingId: "aviso-1",
        platformAccountId: account.id,
        platform: "fb_marketplace",
        format: "post",
        contentId: "texto-1",
        mediaIds: [],
        listingSourceHash: "h",
      },
      { actor: "operator" },
    );
    await publications.transition(
      waiting.id,
      { from: "approved", to: "publishing", changes: { dryRun: true } },
      { actor: "operator" },
    );
    await publications.transition(
      waiting.id,
      { from: "publishing", to: "awaiting_manual_confirm" },
      { actor: "system" },
    );

    await expect(
      disconnectAccount(
        { platformAccounts, publications, queue },
        { accountId: account.id, confirmed: true },
      ),
    ).rejects.toMatchObject({ code: "MANUAL_CONFIRM_PENDING" });
    expect((await platformAccounts.get(account.id))?.status).toBe("connected");
    expect(queue.jobs).toEqual([]);
  });
});
