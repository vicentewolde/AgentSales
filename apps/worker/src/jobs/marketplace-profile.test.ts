import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@agentsales/config";
import { AppError } from "@agentsales/core";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryPlatformAccountRepository,
} from "@agentsales/core/testing";
import {
  type MarketplaceProfile,
  marketplaceProfileDir,
  marketplaceProfileLockPath,
  openMarketplaceProfile,
} from "@agentsales/publishers/marketplace";
import { afterEach, describe, expect, it } from "vitest";
import { MARKETPLACE_PROFILE_QUEUE, marketplaceProfileJob } from "./marketplace-profile.js";

// Un Facebook falso de páginas inventadas (como `fb-smoke.test.ts`): el perfil se abre sin ventana,
// toda petición pasa por `context.route` y nada sale a la red.
const HOME = `<!doctype html><html lang="es"><body><h1>Inicio</h1></body></html>`;
const LOGIN = `<!doctype html><html lang="es"><body><form><input type="password" /></form></body></html>`;

const logger = createLogger({ level: "silent" });
const NOW = new Date("2026-10-10T15:00:00Z");
const broker = contentBrokerFixture();
let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  cleanups = [];
});

async function setup(options: { home?: string; cookies?: Record<string, string> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentsales-mp-profile-"));
  const unexpected: string[] = [];
  const opened: MarketplaceProfile[] = [];
  cleanups.push(async () => {
    for (const profile of opened) await profile.close();
    await rm(root, { recursive: true, force: true });
  });
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const closedBrokers: string[] = [];
  let openProfile = async (brokerId: string) => {
    const profile = await openMarketplaceProfile({
      dir: marketplaceProfileDir(root, brokerId),
      headless: true,
      prepare: async (context) => {
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin === "https://www.facebook.com" && url.pathname === "/") {
            await route.fulfill({ contentType: "text/html", body: options.home ?? HOME });
            return;
          }
          unexpected.push(`${url.origin}${url.pathname}`);
          await route.abort("blockedbyclient");
        });
        const cookies = Object.entries(options.cookies ?? {});
        if (cookies.length > 0) {
          await context.addCookies(
            cookies.map(([name, value]) => ({
              name,
              value,
              domain: ".facebook.com",
              path: "/",
              secure: true,
            })),
          );
        }
      },
    });
    opened.push(profile);
    return profile;
  };
  const deps = {
    profilesRoot: root,
    openProfile: (brokerId: string) => openProfile(brokerId),
    windows: {
      closeForBroker: async (brokerId: string) => {
        closedBrokers.push(brokerId);
      },
    },
    brokers: createInMemoryBrokerRepository([broker]),
    platformAccounts,
    signal: new AbortController().signal,
    now: () => NOW,
    loginWaitMs: 300,
    busyWaitMs: 100,
    pollMs: 20,
  };
  const job = marketplaceProfileJob(deps);
  const run = (data: unknown) =>
    job.run(data, { jobId: "j1", logger, isLastAttempt: true, retryCount: 0 });
  return {
    root,
    deps,
    run,
    platformAccounts,
    closedBrokers,
    unexpected,
    replaceOpen: (fn: typeof openProfile) => {
      openProfile = fn;
    },
  };
}

describe("job marketplace.profile (spec F5 §4.2 y §4.11)", () => {
  it("es exclusive por corredor, sin reintentos y con 15 min", () => {
    expect(MARKETPLACE_PROFILE_QUEUE).toEqual({
      policy: "exclusive",
      retryLimit: 0,
      retryDelay: 0,
      retryBackoff: false,
      expireInSeconds: 900,
    });
  });

  it("login: con la sesión abierta conecta la cuenta sin credenciales y cierra la ventana", async () => {
    const t = await setup({ cookies: { c_user: "100012345", xs: "secreta" } });

    await t.run({ brokerId: broker.id, action: "login", requestedAt: NOW.toISOString() });

    const [account] = await t.platformAccounts.list();
    expect(account).toMatchObject({
      platform: "fb_marketplace",
      externalAccountId: "100012345",
      hasCredentials: false,
      meta: { sessionCheckedAt: NOW.toISOString() },
    });
    expect(JSON.stringify(account)).not.toContain("secreta");
    expect(t.unexpected).toEqual([]);
  });

  it("login: sin sesión al tope no conecta y anota el error en la cuenta que ya existía", async () => {
    const t = await setup({ home: LOGIN });
    await t.platformAccounts.upsertConnected({
      brokerId: broker.id,
      platform: "fb_marketplace",
      externalAccountId: "1",
      displayName: "Facebook",
      tokenExpiresAt: null,
      meta: { userId: "1", connectedAt: NOW.toISOString(), sessionCheckedAt: NOW.toISOString() },
      credentials: null,
    });

    await t.run({ brokerId: broker.id, action: "login", requestedAt: NOW.toISOString() });

    const [account] = await t.platformAccounts.list();
    expect(account?.meta).toMatchObject({
      lastLoginError: { code: "MARKETPLACE_LOGIN_TIMEOUT", at: NOW.toISOString() },
    });
  });

  it("login: con el perfil tomado espera su turno y, si no se libera, lo anota", async () => {
    const t = await setup();
    let tries = 0;
    t.replaceOpen(async () => {
      tries += 1;
      throw new AppError("MARKETPLACE_PROFILE_BUSY", "ocupado");
    });

    await t.run({ brokerId: broker.id, action: "login", requestedAt: NOW.toISOString() });

    expect(tries).toBeGreaterThan(1);
    expect(await t.platformAccounts.list()).toEqual([]);
  });

  it("forget: cierra las ventanas del corredor y borra la carpeta y el candado (idempotente)", async () => {
    const t = await setup();
    const dir = marketplaceProfileDir(t.root, broker.id);
    await mkdir(join(dir, "Default"), { recursive: true });
    await writeFile(join(dir, "Default", "Cookies"), "inventado");
    await writeFile(marketplaceProfileLockPath(dir), "999999999");

    await t.run({ brokerId: broker.id, action: "forget" });

    expect(t.closedBrokers).toEqual([broker.id]);
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(marketplaceProfileLockPath(dir))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(t.run({ brokerId: broker.id, action: "forget" })).resolves.toBeUndefined();
  });

  it("forget: si otro proceso tiene el perfil abierto, no borra nada", async () => {
    const t = await setup();
    const dir = marketplaceProfileDir(t.root, broker.id);
    await mkdir(dir, { recursive: true });
    await writeFile(marketplaceProfileLockPath(dir), String(process.ppid));

    await expect(t.run({ brokerId: broker.id, action: "forget" })).rejects.toMatchObject({
      code: "MARKETPLACE_PROFILE_BUSY",
    });
    expect((await stat(dir)).isDirectory()).toBe(true);
  });
});
