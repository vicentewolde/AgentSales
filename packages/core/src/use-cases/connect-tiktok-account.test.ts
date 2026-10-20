import { describe, expect, it } from "vitest";
import { ALL_SCOPE } from "../access.js";
import { AppError } from "../errors.js";
import type { TikTokAuth, TikTokUser } from "../ports/tiktok-auth.js";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryPlatformAccountRepository,
} from "../testing/index.js";
import { tiktokAccountMetaSchema } from "../tiktok/account.js";
import { connectTikTokAccount } from "./connect-tiktok-account.js";

// F9-T26: conectar TikTok con el código de Login Kit (sin red: TikTok falso).

const NOW = new Date("2026-10-20T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CODE = "codigo-de-prueba-tiktok";
const ACCESS = "act.acceso-de-prueba";
const REFRESH = "rft.refresco-de-prueba";
const OPEN_ID = "open-id-0123456789abcdef";

type FakeOptions = {
  scopes?: string[];
  refreshTokenExpiresAt?: Date | null;
  user?: Partial<TikTokUser>;
  error?: AppError;
};

function fakeTikTok(options: FakeOptions = {}) {
  const calls: string[] = [];
  const tiktok: Pick<TikTokAuth, "exchangeCode" | "user"> = {
    async exchangeCode(code) {
      calls.push(`exchange:${code}`);
      if (options.error) throw options.error;
      return {
        accessToken: ACCESS,
        refreshToken: REFRESH,
        openId: OPEN_ID,
        scopes: options.scopes ?? ["user.info.basic", "video.upload"],
        accessTokenExpiresAt: new Date(NOW.getTime() + 24 * HOUR),
        refreshTokenExpiresAt:
          options.refreshTokenExpiresAt === undefined
            ? new Date(NOW.getTime() + 365 * DAY)
            : options.refreshTokenExpiresAt,
      };
    },
    async user(accessToken) {
      calls.push(`user:${accessToken}`);
      return { openId: OPEN_ID, displayName: "AgentPey", ...options.user };
    },
  };
  return { tiktok, calls };
}

function setup(options: FakeOptions = {}) {
  const broker = contentBrokerFixture();
  const brokers = createInMemoryBrokerRepository([broker]);
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const { tiktok, calls } = fakeTikTok(options);
  return {
    broker,
    platformAccounts,
    calls,
    deps: { brokers, platformAccounts, tiktok, now: () => NOW },
  };
}

describe("connectTikTokAccount", () => {
  it("conecta: el par cifrado, la meta de TikTok y el vencimiento del refresh token", async () => {
    const { broker, platformAccounts, calls, deps } = setup();

    const account = await connectTikTokAccount(deps, { broker: broker.slug, code: CODE });

    expect(calls).toEqual([`exchange:${CODE}`, `user:${ACCESS}`]);
    expect(account).toMatchObject({
      brokerId: broker.id,
      platform: "tiktok",
      externalAccountId: OPEN_ID,
      displayName: "AgentPey",
      status: "connected",
      tokenExpiresAt: new Date(NOW.getTime() + 365 * DAY),
    });
    expect(tiktokAccountMetaSchema.parse(account.meta)).toEqual({
      openId: OPEN_ID,
      scopes: ["user.info.basic", "video.upload"],
      connectedAt: NOW.toISOString(),
      tokenRefreshedAt: null,
      accessTokenExpiresAt: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
    });
    await expect(platformAccounts.getCredentials(account.id)).resolves.toEqual({
      accessToken: ACCESS,
      refreshToken: REFRESH,
    });
    expect(JSON.stringify(account)).not.toMatch(/act\.|rft\./);
  });

  it("sin el vencimiento del refresh token, lo estima a 365 días", async () => {
    const { broker, deps } = setup({ refreshTokenExpiresAt: null });

    const account = await connectTikTokAccount(deps, { broker: broker.slug, code: CODE });

    expect(account.tokenExpiresAt).toEqual(new Date(NOW.getTime() + 365 * DAY));
  });

  it("sin video.upload es TIKTOK_PERMISSION_DENIED y no guarda nada", async () => {
    const { broker, platformAccounts, calls, deps } = setup({ scopes: ["user.info.basic"] });

    await expect(
      connectTikTokAccount(deps, { broker: broker.slug, code: CODE }),
    ).rejects.toMatchObject({
      code: "TIKTOK_PERMISSION_DENIED",
      details: { missing: ["video.upload"] },
    });
    expect(calls).toEqual([`exchange:${CODE}`]);
    await expect(platformAccounts.list(ALL_SCOPE)).resolves.toEqual([]);
  });

  it("sin user.info.basic no lee la cuenta: la nombra por el principio de su open_id", async () => {
    const { broker, calls, deps } = setup({ scopes: ["video.upload"] });

    const account = await connectTikTokAccount(deps, { broker: broker.slug, code: CODE });

    expect(calls).toEqual([`exchange:${CODE}`]);
    expect(account.displayName).toBe("TikTok open-id-");
  });

  it("una cuenta distinta de la del canje es TIKTOK_UNEXPECTED_RESPONSE", async () => {
    const { broker, platformAccounts, deps } = setup({ user: { openId: "otra" } });

    await expect(
      connectTikTokAccount(deps, { broker: broker.slug, code: CODE }),
    ).rejects.toMatchObject({
      code: "TIKTOK_UNEXPECTED_RESPONSE",
      details: { reason: "user_mismatch" },
    });
    await expect(platformAccounts.list(ALL_SCOPE)).resolves.toEqual([]);
  });

  it("un corredor que no existe es BROKER_NOT_FOUND, sin llamar a TikTok", async () => {
    const { calls, deps } = setup();

    await expect(
      connectTikTokAccount(deps, { broker: "no-existe", code: CODE }),
    ).rejects.toMatchObject({ code: "BROKER_NOT_FOUND" });
    expect(calls).toEqual([]);
  });

  it("los errores de TikTok pasan tal cual", async () => {
    const rejected = new AppError("TIKTOK_AUTH_INVALID", "TikTok no aceptó el código");
    const { broker, deps } = setup({ error: rejected });

    await expect(connectTikTokAccount(deps, { broker: broker.slug, code: CODE })).rejects.toBe(
      rejected,
    );
  });

  it("reconectar la misma cuenta actualiza su fila", async () => {
    const { broker, deps } = setup();
    const first = await connectTikTokAccount(deps, { broker: broker.slug, code: CODE });
    const again = await connectTikTokAccount(deps, { broker: broker.slug, code: CODE });

    expect(again.id).toBe(first.id);
  });
});
