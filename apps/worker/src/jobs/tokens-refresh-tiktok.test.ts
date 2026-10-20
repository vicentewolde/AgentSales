import type { InstagramAuth, PlatformTokenRefresher } from "@agentsales/core";
import { createInMemoryPlatformAccountRepository } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { captureLogger } from "../../test/content-fixture.js";
import { registerJobs, type WorkerBoss } from "./registry.js";
import { TOKENS_REFRESH_QUEUE, tokensRefreshJob } from "./tokens-refresh.js";

// F9-T26: TikTok entra al job `tokens.refresh` con su renovación que rota (la misma del intento).

const NOW = new Date("2026-10-20T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

async function setup(tokenRefreshers?: { tiktok: PlatformTokenRefresher }) {
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const account = await platformAccounts.upsertConnected({
    brokerId: "marca-1",
    platform: "tiktok",
    externalAccountId: "open-id-1",
    displayName: "AgentPey",
    tokenExpiresAt: new Date(NOW.getTime() + 300 * DAY),
    meta: { openId: "open-id-1", scopes: [], accessTokenExpiresAt: NOW.toISOString() },
    credentials: { accessToken: "act.viejo", refreshToken: "rft.viejo" },
  });
  let work: Parameters<WorkerBoss["work"]>[2] | undefined;
  const boss: WorkerBoss = {
    createQueue: async () => {},
    updateQueue: async () => {},
    getQueue: async () => ({ policy: "exclusive" }),
    work: async (_name, _options, handler) => {
      work = handler;
      return "w1";
    },
    schedule: async () => {},
  };
  const unusedInstagram: Pick<InstagramAuth, "refresh"> = {
    refresh: async () => {
      throw new Error("Instagram no debía llamarse");
    },
  };
  const { logger, lines } = captureLogger();
  await registerJobs(
    boss,
    [
      tokensRefreshJob({
        platformAccounts,
        instagram: unusedInstagram,
        mercadoLibre: null,
        ...(tokenRefreshers === undefined ? {} : { refreshers: tokenRefreshers }),
        signal: new AbortController().signal,
        now: () => NOW,
      }),
    ],
    logger,
  );
  const run = () =>
    work?.([{ id: "job-1", data: {}, retryCount: 0, retryLimit: TOKENS_REFRESH_QUEUE.retryLimit }]);
  return { platformAccounts, account, run, lines };
}

describe("tokens.refresh con TikTok (F9-T26)", () => {
  it("renueva la cuenta de TikTok con el par que rota y no registra tokens", async () => {
    const calls: string[] = [];
    const tiktok: PlatformTokenRefresher = {
      async refresh(refreshToken) {
        calls.push(refreshToken);
        return {
          accessToken: "act.nuevo",
          refreshToken: "rft.nuevo",
          accessTokenExpiresAt: new Date(NOW.getTime() + DAY),
          refreshTokenExpiresAt: new Date(NOW.getTime() + 365 * DAY),
        };
      },
      isRejected: () => false,
    };
    const { platformAccounts, account, run, lines } = await setup({ tiktok });

    await run();

    expect(calls).toEqual(["rft.viejo"]);
    expect(platformAccounts.storedCredentials(account.id)).toEqual({
      accessToken: "act.nuevo",
      refreshToken: "rft.nuevo",
    });
    expect(JSON.stringify(lines)).not.toMatch(/act\.|rft\./);
  });

  it("sin la app de TikTok, la cuenta queda sin cambiar y el aviso lo dice", async () => {
    const { platformAccounts, account, run, lines } = await setup();

    await run();

    expect(platformAccounts.storedCredentials(account.id)).toEqual({
      accessToken: "act.viejo",
      refreshToken: "rft.viejo",
    });
    expect(JSON.stringify(lines)).toContain("TOKEN_REFRESH_NOT_CONFIGURED");
  });
});
