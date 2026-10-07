import { AppError, type InstagramAuth, type MercadoLibreAuth } from "@agentsales/core";
import {
  createInMemoryJobQueue,
  createInMemoryPlatformAccountRepository,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { captureLogger } from "../../test/content-fixture.js";
import { registerJobs, type WorkerBoss } from "./registry.js";
import {
  enqueueTokensRefresh,
  TOKENS_REFRESH_KEY,
  TOKENS_REFRESH_QUEUE,
  TOKENS_REFRESH_SCHEDULE,
  tokensRefreshJob,
} from "./tokens-refresh.js";

const NOW = new Date("2026-10-06T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const TOKEN = "IGAA-secreto-del-test";

/** Un pg-boss falso: guarda el handler, la cola creada y el cron. */
function fakeBoss() {
  const bossCalls: { name: string; args: unknown[] }[] = [];
  let work: Parameters<WorkerBoss["work"]>[2] | undefined;
  const boss: WorkerBoss = {
    createQueue: async (...args) => {
      bossCalls.push({ name: "createQueue", args });
    },
    updateQueue: async () => {},
    getQueue: async () => ({ policy: "exclusive" }),
    work: async (_name, _options, handler) => {
      work = handler;
      return "w1";
    },
    schedule: async (...args) => {
      bossCalls.push({ name: "schedule", args });
    },
  };
  const run = (retryCount = 0) =>
    work?.([{ id: "job-1", data: {}, retryCount, retryLimit: TOKENS_REFRESH_QUEUE.retryLimit }]);
  return { boss, bossCalls, run };
}

async function setup(options: { mercadoLibreConfigured?: boolean } = {}) {
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const add = (externalAccountId: string, token: string) =>
    platformAccounts.upsertConnected({
      brokerId: "broker-1",
      platform: "instagram",
      externalAccountId,
      displayName: `@cuenta${externalAccountId}`,
      tokenExpiresAt: new Date(NOW.getTime() + 10 * DAY),
      meta: {
        accountType: "BUSINESS",
        permissions: null,
        connectedAt: new Date(NOW.getTime() - 50 * DAY).toISOString(),
        tokenRefreshedAt: new Date(NOW.getTime() - 50 * DAY).toISOString(),
        tokenExpiryEstimated: false,
      },
      credentials: { accessToken: token },
    });
  /** Una cuenta de Mercado Libre refrescada hace 8 días: al lote le toca. */
  const addMl = (externalAccountId: string, refreshToken: string) =>
    platformAccounts.upsertConnected({
      brokerId: "broker-1",
      platform: "portal_inmobiliario",
      externalAccountId,
      displayName: `CUENTA_${externalAccountId}`,
      tokenExpiresAt: new Date(NOW.getTime() + 170 * DAY),
      meta: {
        userId: externalAccountId,
        nickname: `CUENTA_${externalAccountId}`,
        siteId: "MLC",
        userType: "normal",
        scopes: ["offline_access", "read", "write"],
        testUser: false,
        connectedAt: new Date(NOW.getTime() - 30 * DAY).toISOString(),
        tokenRefreshedAt: new Date(NOW.getTime() - 8 * DAY).toISOString(),
        accessTokenExpiresAt: new Date(NOW.getTime() - DAY).toISOString(),
        tokenExpiryEstimated: true,
      },
      credentials: { accessToken: `APP_USR-${refreshToken}`, refreshToken },
    });
  const mlCalls: string[] = [];
  const mercadoLibre: Pick<MercadoLibreAuth, "refresh"> = {
    async refresh(refreshToken) {
      mlCalls.push(refreshToken);
      if (refreshToken.startsWith("TG-vencido")) {
        throw new AppError("ML_AUTH_INVALID", "Mercado Libre ya no acepta el acceso");
      }
      return {
        accessToken: `APP_USR-nuevo-${refreshToken}`,
        refreshToken: `TG-nuevo-${refreshToken}`,
        accessTokenExpiresAt: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
        scopes: ["offline_access", "read", "write"],
        userId: null,
      };
    },
  };
  const calls: string[] = [];
  const instagram: Pick<InstagramAuth, "refresh"> = {
    async refresh(accessToken) {
      calls.push(accessToken);
      if (accessToken.startsWith("red")) {
        throw new AppError("IG_UNAVAILABLE", "Instagram no responde", { retriable: true });
      }
      if (accessToken.startsWith("malo")) {
        throw new AppError("IG_AUTH_INVALID", "El acceso a Instagram venció");
      }
      return { accessToken: `${accessToken}-nuevo`, expiresAt: new Date(NOW.getTime() + 60 * DAY) };
    },
  };
  const { logger, lines } = captureLogger();
  const boss = fakeBoss();
  const job = tokensRefreshJob({
    platformAccounts,
    instagram,
    mercadoLibre: options.mercadoLibreConfigured === false ? null : mercadoLibre,
    signal: new AbortController().signal,
    now: () => NOW,
  });
  await registerJobs(boss.boss, [job], logger);
  return { platformAccounts, add, addMl, calls, mlCalls, lines, ...boss };
}

describe("tokens.refresh", () => {
  it("la cola es exclusive con clave fija y el cron diario lleva la misma clave", async () => {
    const { bossCalls } = await setup();

    expect(TOKENS_REFRESH_QUEUE).toEqual({
      policy: "exclusive",
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 300,
    });
    expect(bossCalls).toEqual([
      { name: "createQueue", args: ["tokens.refresh", TOKENS_REFRESH_QUEUE] },
      {
        name: "schedule",
        args: [
          "tokens.refresh",
          "0 12 * * *",
          {},
          { tz: "America/Santiago", missed: "skip", singletonKey: TOKENS_REFRESH_KEY },
        ],
      },
    ]);
    expect(TOKENS_REFRESH_SCHEDULE.singletonKey).toBe(TOKENS_REFRESH_KEY);
  });

  it("refresca, marca las vencidas y registra solo ids, nunca tokens", async () => {
    const { platformAccounts, add, calls, lines, run } = await setup();
    const ok = await add("1", TOKEN);
    const rejected = await add("2", `malo-${TOKEN}`);

    await run();

    expect(calls).toEqual([TOKEN, `malo-${TOKEN}`]);
    expect(platformAccounts.storedCredentials(ok.id)).toEqual({ accessToken: `${TOKEN}-nuevo` });
    expect((await platformAccounts.get(rejected.id))?.status).toBe("expired");
    expect(lines.find((line) => line.msg === "tokens revisados")).toMatchObject({
      refreshed: [ok.id],
      expired: [rejected.id],
      skipped: 0,
      failed: [],
    });
    expect(
      lines.find((line) => line.msg === "cuentas con el acceso vencido: hay que reconectarlas"),
    ).toMatchObject({ level: 40, accountIds: [rejected.id] });
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });

  it("un error de red falla el job para que pg-boss lo reintente, y el reintento no repite lo hecho", async () => {
    const { add, calls, lines, run } = await setup();
    await add("1", TOKEN);
    const network = await add("2", "red-1");

    await expect(run()).rejects.toMatchObject({
      code: "TOKENS_REFRESH_INCOMPLETE",
      retriable: true,
    });
    const failure = lines.find((line) => line.level === 50);
    expect(failure).toMatchObject({
      code: "TOKENS_REFRESH_INCOMPLETE",
      retriable: true,
      accountIds: [network.id],
    });
    expect(failure).not.toHaveProperty("err");

    await expect(run(1)).rejects.toMatchObject({ code: "TOKENS_REFRESH_INCOMPLETE" });
    expect(calls).toEqual([TOKEN, "red-1", "red-1"]);
    expect(lines.filter((line) => line.msg === "tokens revisados").at(-1)).toMatchObject({
      refreshed: [],
      skipped: 1,
      failed: [{ accountId: network.id, code: "IG_UNAVAILABLE", retriable: true }],
    });
  });

  it("credenciales ilegibles no se reintentan: la cuenta queda en error y el job termina", async () => {
    const { platformAccounts, add, run } = await setup();
    const account = await add("1", TOKEN);
    platformAccounts.corruptCredentials(account.id);

    await run();

    expect((await platformAccounts.get(account.id))?.status).toBe("error");
  });

  it("refresca también Mercado Libre (el par completo) y marca la rechazada, sin tokens en el log", async () => {
    const { platformAccounts, add, addMl, calls, mlCalls, lines, run } = await setup();
    const instagram = await add("1", TOKEN);
    const ml = await addMl("8035443", "TG-secreto-del-test");
    const mlRejected = await addMl("8035444", "TG-vencido-del-test");

    await run();

    expect(calls).toEqual([TOKEN]);
    expect(mlCalls).toEqual(["TG-secreto-del-test", "TG-vencido-del-test"]);
    expect(platformAccounts.storedCredentials(ml.id)).toEqual({
      accessToken: "APP_USR-nuevo-TG-secreto-del-test",
      refreshToken: "TG-nuevo-TG-secreto-del-test",
    });
    expect((await platformAccounts.get(mlRejected.id))?.status).toBe("expired");
    expect(lines.find((line) => line.msg === "tokens revisados")).toMatchObject({
      refreshed: [instagram.id, ml.id],
      expired: [mlRejected.id],
      failed: [],
    });
    expect(JSON.stringify(lines)).not.toMatch(/IGAA|APP_USR|TG-/);
  });

  it("sin el par de Mercado Libre salta esas cuentas sin cambiarlas, sigue con Instagram, avisa y no reintenta", async () => {
    const { platformAccounts, add, addMl, calls, mlCalls, lines, run } = await setup({
      mercadoLibreConfigured: false,
    });
    const instagram = await add("1", TOKEN);
    const ml = await addMl("8035443", "TG-secreto-del-test");
    const before = await platformAccounts.get(ml.id);

    await run();

    expect(calls).toEqual([TOKEN]);
    expect(mlCalls).toEqual([]);
    expect(await platformAccounts.get(ml.id)).toEqual(before);
    expect(lines.find((line) => line.msg === "tokens revisados")).toMatchObject({
      refreshed: [instagram.id],
      failed: [{ accountId: ml.id, code: "MERCADOLIBRE_NOT_CONFIGURED", retriable: false }],
    });
    expect(lines.find((line) => String(line.msg).startsWith("cuentas sin renovar"))).toMatchObject({
      level: 40,
      failed: [{ accountId: ml.id, code: "MERCADOLIBRE_NOT_CONFIGURED", retriable: false }],
    });
    expect(lines.some((line) => line.level === 50)).toBe(false);
  });

  it("el refresco del arranque se encola con la clave fija, sin datos", async () => {
    const queue = createInMemoryJobQueue();

    await enqueueTokensRefresh(queue);

    expect(queue.jobs).toEqual([
      { name: "tokens.refresh", data: {}, options: { singletonKey: TOKENS_REFRESH_KEY } },
    ]);
  });
});
