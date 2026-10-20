import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import type { InstagramAuth } from "../ports/instagram-auth.js";
import type { PlatformTokenRefresher, RefreshedTokens } from "../ports/token-refresher.js";
import { createInMemoryPlatformAccountRepository } from "../testing/index.js";
import {
  type RefreshAccountTokensDeps,
  refreshAccountToken,
  refreshAccountTokens,
} from "./refresh-account-tokens.js";

// F9-T26: TikTok en el refresco a pedido y en el job `tokens.refresh`, con la política del token
// que rota (`ensureRotatingAccessToken`, la misma del intento al publicar).

const NOW = new Date("2026-10-20T12:00:00Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const fromNow = (ms: number) => new Date(NOW.getTime() + ms);
const OLD = { accessToken: "act.viejo", refreshToken: "rft.viejo" };

/** TikTok falso: `rft.vencido` es el `invalid_grant`; `rft.caido`, un corte. El par nuevo rota. */
function fakeTikTok() {
  const calls: string[] = [];
  const refresher: PlatformTokenRefresher = {
    async refresh(refreshToken): Promise<RefreshedTokens> {
      calls.push(refreshToken);
      if (refreshToken === "rft.vencido") {
        throw new AppError("TIKTOK_AUTH_INVALID", "TikTok ya no acepta el acceso", {
          details: { oauthError: "invalid_grant" },
        });
      }
      if (refreshToken === "rft.caido") {
        throw new AppError("TIKTOK_UNAVAILABLE", "TikTok no respondió", { retriable: true });
      }
      return {
        accessToken: `act.nuevo-${calls.length}`,
        refreshToken: `rft.nuevo-${calls.length}`,
        accessTokenExpiresAt: fromNow(DAY),
        refreshTokenExpiresAt: fromNow(365 * DAY),
      };
    },
    isRejected: (error) =>
      error instanceof AppError &&
      error.code === "TIKTOK_AUTH_INVALID" &&
      error.details?.oauthError === "invalid_grant",
  };
  return { refresher, calls };
}

const unusedInstagram: Pick<InstagramAuth, "refresh"> = {
  refresh: async () => {
    throw new Error("Instagram no debía llamarse");
  },
};

function setup({ withRefresher = true }: { withRefresher?: boolean } = {}) {
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const { refresher, calls } = fakeTikTok();
  const deps: RefreshAccountTokensDeps = {
    platformAccounts,
    instagram: unusedInstagram,
    mercadoLibre: null,
    ...(withRefresher ? { tokenRefreshers: { tiktok: refresher } } : {}),
    now: () => NOW,
  };
  const add = ({
    accessTokenExpiresAt = fromNow(10 * MIN),
    credentials = OLD,
  }: {
    accessTokenExpiresAt?: Date;
    credentials?: typeof OLD;
  } = {}) =>
    platformAccounts.upsertConnected({
      brokerId: "marca-1",
      platform: "tiktok",
      externalAccountId: "open-id-1",
      displayName: "AgentPey",
      tokenExpiresAt: fromNow(300 * DAY),
      meta: {
        openId: "open-id-1",
        scopes: ["user.info.basic", "video.upload"],
        connectedAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
        tokenRefreshedAt: null,
        accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
      },
      credentials,
    });
  return { platformAccounts, calls, deps, add };
}

describe("refreshAccountToken · TikTok (F9-T26)", () => {
  it("con el access token por vencer: renueva una vez y guarda el par que rotó y los vencimientos", async () => {
    const { platformAccounts, calls, deps, add } = setup();
    const account = await add();

    const result = await refreshAccountToken(deps, { accountId: account.id });

    expect(result.outcome).toBe("refreshed");
    expect(calls).toEqual(["rft.viejo"]);
    expect(platformAccounts.storedCredentials(account.id)).toEqual({
      accessToken: "act.nuevo-1",
      refreshToken: "rft.nuevo-1",
    });
    expect(result.account).toMatchObject({
      status: "connected",
      tokenExpiresAt: fromNow(365 * DAY),
      meta: {
        openId: "open-id-1",
        tokenRefreshedAt: NOW.toISOString(),
        accessTokenExpiresAt: fromNow(DAY).toISOString(),
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/act\.|rft\./);
  });

  it("con el access token vigente (más de 30 min), no descifra ni llama: not_due", async () => {
    const { calls, deps, add } = setup();
    const account = await add({ accessTokenExpiresAt: fromNow(5 * HOUR) });

    await expect(refreshAccountToken(deps, { accountId: account.id })).resolves.toMatchObject({
      outcome: "skipped",
      reason: "not_due",
      refreshableAt: fromNow(5 * HOUR - 30 * MIN),
    });
    expect(calls).toEqual([]);
  });

  it("con force renueva aunque el vigente sirva", async () => {
    const { platformAccounts, calls, deps, add } = setup();
    const account = await add({ accessTokenExpiresAt: fromNow(5 * HOUR) });

    const result = await refreshAccountToken(deps, { accountId: account.id, force: true });

    expect(result.outcome).toBe("refreshed");
    expect(calls).toEqual(["rft.viejo"]);
    expect(platformAccounts.storedCredentials(account.id)?.accessToken).toBe("act.nuevo-1");
  });

  it("un refresh token rechazado (invalid_grant) deja la cuenta vencida: expired, token_rejected", async () => {
    const { deps, add } = setup();
    const account = await add({ credentials: { ...OLD, refreshToken: "rft.vencido" } });

    const result = await refreshAccountToken(deps, { accountId: account.id });

    expect(result).toMatchObject({
      outcome: "expired",
      reason: "token_rejected",
      account: { status: "expired" },
    });
  });

  it("sin la app de TikTok configurada es TOKEN_REFRESH_NOT_CONFIGURED, sin cambiar la cuenta", async () => {
    const { platformAccounts, deps, add } = setup({ withRefresher: false });
    const account = await add();

    await expect(refreshAccountToken(deps, { accountId: account.id })).rejects.toMatchObject({
      code: "TOKEN_REFRESH_NOT_CONFIGURED",
    });
    expect((await platformAccounts.get(account.id))?.status).toBe("connected");
    expect(platformAccounts.storedCredentials(account.id)).toEqual(OLD);
  });
});

describe("refreshAccountTokens · lote con TikTok (F9-T26)", () => {
  it("renueva las que tocan, salta las vigentes y anota la caída como reintentable", async () => {
    const { deps, platformAccounts } = setup();
    const due = await platformAccounts.upsertConnected({
      brokerId: "marca-1",
      platform: "tiktok",
      externalAccountId: "open-id-due",
      displayName: "Una",
      tokenExpiresAt: fromNow(300 * DAY),
      meta: { openId: "open-id-due", scopes: [], accessTokenExpiresAt: fromNow(MIN).toISOString() },
      credentials: OLD,
    });
    await platformAccounts.upsertConnected({
      brokerId: "marca-2",
      platform: "tiktok",
      externalAccountId: "open-id-fresh",
      displayName: "Dos",
      tokenExpiresAt: fromNow(300 * DAY),
      meta: {
        openId: "open-id-fresh",
        scopes: [],
        accessTokenExpiresAt: fromNow(20 * HOUR).toISOString(),
      },
      credentials: OLD,
    });
    const down = await platformAccounts.upsertConnected({
      brokerId: "marca-3",
      platform: "tiktok",
      externalAccountId: "open-id-down",
      displayName: "Tres",
      tokenExpiresAt: fromNow(300 * DAY),
      meta: { openId: "open-id-down", scopes: [] },
      credentials: { ...OLD, refreshToken: "rft.caido" },
    });

    const report = await refreshAccountTokens(deps);

    expect(report.refreshed).toEqual([due.id]);
    expect(report.skipped).toBe(1);
    expect(report.failed).toEqual([
      { accountId: down.id, code: "TIKTOK_UNAVAILABLE", retriable: true },
    ]);
  });
});
