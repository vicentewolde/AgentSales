import { describe, expect, it } from "vitest";
import { AppError, isAppError } from "../errors.js";
import type { PlatformTokenRefresher, RefreshedTokens } from "../ports/token-refresher.js";
import type { XAuth, XCodeExchange } from "../ports/x-auth.js";
import { contentBrokerFixture } from "../testing/content-fixtures.js";
import {
  createInMemoryBrokerRepository,
  createInMemoryPlatformAccountRepository,
} from "../testing/index.js";
import { xAccountMetaSchema, xSpendLimitOf } from "../x/account.js";
import { ensureRotatingAccessToken } from "./ensure-access-token.js";
import { refreshAccountToken, refreshAccountTokens } from "./refresh-account-tokens.js";
import { connectXAccount, setXSpendLimit } from "./x-account.js";

// F9-T16: conectar X por OAuth con PKCE y su renovación en el job `tokens.refresh` con la misma
// función del intento (`ensureRotatingAccessToken`, ADR-0029 punto 11).

const NOW = new Date("2026-10-20T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const fromNow = (ms: number) => new Date(NOW.getTime() + ms);

const ALL_SCOPES = ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"];

function fakeX(options: { scopes?: string[]; userId?: string } = {}) {
  const calls: Array<{ code: string; verifier: string }> = [];
  const x: Pick<XAuth, "exchangeCode" | "me"> = {
    async exchangeCode(code, codeVerifier): Promise<XCodeExchange> {
      calls.push({ code, verifier: codeVerifier });
      return {
        accessToken: "access-conectado",
        refreshToken: "refresh-conectado",
        accessTokenExpiresAt: fromNow(2 * HOUR),
        refreshTokenExpiresAt: null,
        scopes: options.scopes ?? ALL_SCOPES,
      };
    },
    async me() {
      return { id: options.userId ?? "12345", username: "agentpey", name: "AgentPey" };
    },
  };
  return { x, calls };
}

/** La renovación falsa de X: rota el par, y `refresh-usado…` es `invalid_grant`. */
function fakeRefresher() {
  const calls: string[] = [];
  const refresher: PlatformTokenRefresher = {
    async refresh(refreshToken): Promise<RefreshedTokens> {
      calls.push(refreshToken);
      if (refreshToken.startsWith("refresh-usado")) {
        throw new AppError("X_AUTH_INVALID", "rechazado", {
          details: { oauthError: "invalid_grant" },
        });
      }
      return {
        accessToken: `access-nuevo-${calls.length}`,
        refreshToken: `refresh-nuevo-${calls.length}`,
        accessTokenExpiresAt: fromNow(2 * HOUR),
        refreshTokenExpiresAt: null,
      };
    },
    isRejected: (error) =>
      isAppError(error) &&
      (error.details as { oauthError?: string } | undefined)?.oauthError === "invalid_grant",
  };
  return { refresher, calls };
}

async function setup() {
  const broker = contentBrokerFixture({ kind: "brand" });
  const brokers = createInMemoryBrokerRepository([broker]);
  const platformAccounts = createInMemoryPlatformAccountRepository();
  return { broker, brokers, platformAccounts };
}

async function connected(
  platformAccounts: ReturnType<typeof createInMemoryPlatformAccountRepository>,
  brokerId: string,
  { refreshToken = "refresh-viejo", accessTokenExpiresAt = fromNow(10 * 60_000) } = {},
) {
  return platformAccounts.upsertConnected({
    brokerId,
    platform: "x",
    externalAccountId: "12345",
    displayName: "@agentpey",
    tokenExpiresAt: null,
    meta: {
      userId: "12345",
      username: "agentpey",
      scopes: ALL_SCOPES,
      connectedAt: NOW.toISOString(),
      tokenRefreshedAt: null,
      accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
    },
    credentials: { accessToken: "access-viejo", refreshToken },
  });
}

describe("connectXAccount", () => {
  it("canjea con el verificador, lee el usuario y guarda el par cifrado y la meta sin secretos", async () => {
    const { broker, brokers, platformAccounts } = await setup();
    const { x, calls } = fakeX();
    const account = await connectXAccount(
      { brokers, platformAccounts, x, now: () => NOW },
      { broker: broker.slug, code: "codigo", codeVerifier: "verificador" },
    );
    expect(calls).toEqual([{ code: "codigo", verifier: "verificador" }]);
    expect(account).toMatchObject({
      platform: "x",
      status: "connected",
      externalAccountId: "12345",
      displayName: "@agentpey",
      tokenExpiresAt: null,
    });
    expect(xAccountMetaSchema.parse(account.meta)).toMatchObject({
      username: "agentpey",
      accessTokenExpiresAt: fromNow(2 * HOUR).toISOString(),
    });
    expect(JSON.stringify(account.meta)).not.toContain("access-conectado");
    expect(await platformAccounts.getCredentials(account.id)).toEqual({
      accessToken: "access-conectado",
      refreshToken: "refresh-conectado",
    });
  });

  it("sin los permisos de publicar no conecta", async () => {
    const { broker, brokers, platformAccounts } = await setup();
    const { x } = fakeX({ scopes: ["tweet.read", "users.read", "offline.access"] });
    const error = await connectXAccount(
      { brokers, platformAccounts, x },
      { broker: broker.slug, code: "c", codeVerifier: "v" },
    ).catch((caught: unknown) => caught);
    expect(isAppError(error) && error.code).toBe("X_PERMISSION_MISSING");
    expect(await platformAccounts.listByBroker(broker.id, "x")).toEqual([]);
  });

  it("reconectar el mismo usuario conserva el tope de gasto", async () => {
    const { broker, brokers, platformAccounts } = await setup();
    const { x } = fakeX();
    const first = await connectXAccount(
      { brokers, platformAccounts, x, now: () => NOW },
      { broker: broker.slug, code: "c", codeVerifier: "v" },
    );
    await setXSpendLimit({ platformAccounts }, { accountId: first.id, spendLimitUsd: 3 });
    const again = await connectXAccount(
      { brokers, platformAccounts, x, now: () => NOW },
      { broker: broker.slug, code: "c2", codeVerifier: "v2" },
    );
    expect(xSpendLimitOf(again)).toBe(3);
  });
});

describe("X en el refresco de tokens (tokens.refresh)", () => {
  it("el lote renueva con la misma función del intento y guarda el par que rota", async () => {
    const { broker, platformAccounts } = await setup();
    const account = await connected(platformAccounts, broker.id);
    const { refresher, calls } = fakeRefresher();
    const report = await refreshAccountTokens({
      platformAccounts,
      instagram: { refresh: () => Promise.reject(new Error("no se usa")) },
      mercadoLibre: null,
      refreshers: { x: refresher },
      now: () => NOW,
    });
    expect(report.refreshed).toEqual([account.id]);
    expect(calls).toEqual(["refresh-viejo"]);
    expect(await platformAccounts.getCredentials(account.id)).toEqual({
      accessToken: "access-nuevo-1",
      refreshToken: "refresh-nuevo-1",
    });
    // Un intento que llega después no vuelve a renovar: el token quedó fresco.
    const token = await ensureRotatingAccessToken(
      { platformAccounts, refreshers: { x: refresher }, now: () => NOW },
      account.id,
    );
    expect(token).toBe("access-nuevo-1");
    expect(calls).toHaveLength(1);
  });

  it("un token fresco no se renueva sin force; con force sí", async () => {
    const { broker, platformAccounts } = await setup();
    const account = await connected(platformAccounts, broker.id, {
      accessTokenExpiresAt: fromNow(2 * HOUR),
    });
    const { refresher, calls } = fakeRefresher();
    const deps = {
      platformAccounts,
      instagram: { refresh: () => Promise.reject(new Error("no se usa")) },
      mercadoLibre: null,
      refreshers: { x: refresher },
      now: () => NOW,
    };
    const skipped = await refreshAccountToken(deps, { accountId: account.id });
    expect(skipped).toMatchObject({ outcome: "skipped", reason: "not_due" });
    expect(calls).toEqual([]);
    const forced = await refreshAccountToken(deps, { accountId: account.id, force: true });
    expect(forced.outcome).toBe("refreshed");
    expect(calls).toEqual(["refresh-viejo"]);
  });

  it("solo invalid_grant deja la cuenta vencida; sin la app de X, no se toca", async () => {
    const { broker, platformAccounts } = await setup();
    const account = await connected(platformAccounts, broker.id, {
      refreshToken: "refresh-usado-1",
    });
    const { refresher } = fakeRefresher();
    const base = {
      platformAccounts,
      instagram: { refresh: () => Promise.reject(new Error("no se usa")) },
      mercadoLibre: null,
      now: () => NOW,
    };
    const notConfigured = await refreshAccountTokens(base);
    expect(notConfigured.failed).toEqual([
      { accountId: account.id, code: "TOKEN_REFRESH_NOT_CONFIGURED", retriable: false },
    ]);
    expect((await platformAccounts.get(account.id))?.status).toBe("connected");

    const result = await refreshAccountToken(
      { ...base, refreshers: { x: refresher } },
      { accountId: account.id },
    );
    expect(result).toMatchObject({ outcome: "expired", reason: "token_rejected" });
    expect((await platformAccounts.get(account.id))?.status).toBe("expired");
  });
});
