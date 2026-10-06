import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import type { InstagramAuth } from "../ports/instagram-auth.js";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryPlatformAccountRepository,
} from "../testing/index.js";
import { connectAccount } from "./connect-account.js";
import { disconnectAccount } from "./disconnect-account.js";

const NOW = new Date("2026-10-06T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

/** Instagram falso: canjea el código y responde `/me` según el token. */
function fakeInstagram(options: { permissions?: string[]; error?: AppError } = {}) {
  const calls: string[] = [];
  const instagram: Pick<InstagramAuth, "exchangeCode" | "me"> = {
    async exchangeCode(code) {
      calls.push(`exchange:${code}`);
      if (options.error) throw options.error;
      return {
        accessToken: "IGAA-largo-oauth",
        expiresAt: new Date(NOW.getTime() + 59 * DAY),
        permissions: options.permissions ?? [
          "instagram_business_basic",
          "instagram_business_content_publish",
        ],
      };
    },
    async me(accessToken) {
      calls.push(`me:${accessToken}`);
      if (options.error) throw options.error;
      return {
        userId: accessToken === "IGAA-otra" ? "17841400000000002" : "17841400000000001",
        username: accessToken === "IGAA-otra" ? "otra" : "corredora",
        accountType: "BUSINESS",
      };
    },
  };
  return { instagram, calls };
}

function setup(options: Parameters<typeof fakeInstagram>[0] = {}) {
  const broker = contentBrokerFixture();
  const brokers = createInMemoryBrokerRepository([broker]);
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const { instagram, calls } = fakeInstagram(options);
  const deps = { brokers, platformAccounts, instagram, now: () => NOW };
  return { broker, platformAccounts, calls, deps };
}

describe("connectAccount", () => {
  it("con el token del panel: guarda la cuenta conectada, permisos desconocidos y vencimiento estimado", async () => {
    const { broker, platformAccounts, calls, deps } = setup();
    const account = await connectAccount(deps, {
      broker: broker.slug,
      grant: { kind: "token", accessToken: "  IGAA-panel  " },
    });

    expect(account).toMatchObject({
      brokerId: broker.id,
      platform: "instagram",
      externalAccountId: "17841400000000001",
      displayName: "@corredora",
      status: "connected",
      hasCredentials: true,
      tokenExpiresAt: new Date(NOW.getTime() + 60 * DAY),
      meta: {
        accountType: "BUSINESS",
        permissions: null,
        connectedAt: NOW.toISOString(),
        tokenRefreshedAt: null,
        tokenExpiryEstimated: true,
      },
    });
    expect(platformAccounts.storedCredentials(account.id)).toEqual({ accessToken: "IGAA-panel" });
    expect(calls).toEqual(["me:IGAA-panel"]);
    expect(JSON.stringify(account)).not.toContain("IGAA-panel");
  });

  it("con el código del OAuth: canjea, exige el permiso de publicar y guarda el vencimiento real", async () => {
    const { broker, platformAccounts, calls, deps } = setup();
    const account = await connectAccount(deps, {
      broker: broker.slug,
      grant: { kind: "oauth_code", code: "AQB-codigo" },
    });
    expect(account).toMatchObject({
      tokenExpiresAt: new Date(NOW.getTime() + 59 * DAY),
      meta: {
        permissions: ["instagram_business_basic", "instagram_business_content_publish"],
        tokenRefreshedAt: NOW.toISOString(),
        tokenExpiryEstimated: false,
      },
    });
    expect(platformAccounts.storedCredentials(account.id)).toEqual({
      accessToken: "IGAA-largo-oauth",
    });
    expect(calls).toEqual(["exchange:AQB-codigo", "me:IGAA-largo-oauth"]);
  });

  it("sin el permiso de publicar es IG_PERMISSION_DENIED y no guarda nada", async () => {
    const { broker, platformAccounts, calls, deps } = setup({
      permissions: ["instagram_business_basic"],
    });
    await expect(
      connectAccount(deps, { broker: broker.slug, grant: { kind: "oauth_code", code: "c" } }),
    ).rejects.toMatchObject({ code: "IG_PERMISSION_DENIED", retriable: false });
    expect(await platformAccounts.list()).toEqual([]);
    expect(calls).toEqual(["exchange:c"]);
  });

  it("conectar otra cuenta de Instagram del corredor desconecta la anterior; reconectar la misma actualiza su fila", async () => {
    const { broker, deps } = setup();
    const first = await connectAccount(deps, {
      broker: broker.slug,
      grant: { kind: "token", accessToken: "IGAA-panel" },
    });
    const again = await connectAccount(deps, {
      broker: broker.slug,
      grant: { kind: "token", accessToken: "IGAA-panel-nuevo" },
    });
    expect(again.id).toBe(first.id);

    const other = await connectAccount(deps, {
      broker: broker.slug,
      grant: { kind: "token", accessToken: "IGAA-otra" },
    });
    const accounts = await deps.platformAccounts.list();
    expect(accounts.map((account) => [account.id, account.status])).toEqual([
      [first.id, "revoked"],
      [other.id, "connected"],
    ]);
  });

  it("un corredor que no existe es BROKER_NOT_FOUND, sin llamar a Instagram", async () => {
    const { calls, deps } = setup();
    await expect(
      connectAccount(deps, { broker: "no-existe", grant: { kind: "token", accessToken: "x" } }),
    ).rejects.toMatchObject({ code: "BROKER_NOT_FOUND" });
    expect(calls).toEqual([]);
  });

  it("los errores de Instagram pasan tal cual y no se guarda nada", async () => {
    const { broker, platformAccounts, deps } = setup({
      error: new AppError("IG_UNAVAILABLE", "Instagram no respondió", { retriable: true }),
    });
    await expect(
      connectAccount(deps, { broker: broker.slug, grant: { kind: "token", accessToken: "x" } }),
    ).rejects.toMatchObject({ code: "IG_UNAVAILABLE", retriable: true });
    expect(await platformAccounts.list()).toEqual([]);
  });
});

describe("disconnectAccount", () => {
  it("deja la cuenta en revoked sin credenciales; repetirlo no cambia nada", async () => {
    const { broker, platformAccounts, deps } = setup();
    const account = await connectAccount(deps, {
      broker: broker.slug,
      grant: { kind: "token", accessToken: "IGAA-panel" },
    });
    const disconnected = await disconnectAccount(deps, { accountId: account.id });
    expect(disconnected).toMatchObject({ status: "revoked", hasCredentials: false });
    expect(platformAccounts.storedCredentials(account.id)).toBeNull();
    await expect(disconnectAccount(deps, { accountId: account.id })).resolves.toMatchObject({
      status: "revoked",
    });
  });

  it("una cuenta que no existe es ACCOUNT_NOT_FOUND", async () => {
    const { deps } = setup();
    await expect(disconnectAccount(deps, { accountId: "no-existe" })).rejects.toMatchObject({
      code: "ACCOUNT_NOT_FOUND",
    });
  });
});
