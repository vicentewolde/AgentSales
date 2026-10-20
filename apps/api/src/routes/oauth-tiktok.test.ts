import { randomUUID } from "node:crypto";
import { createStateSigner } from "@agentsales/config";
import { ALL_SCOPE, AppError, type TikTokAuth } from "@agentsales/core";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryPlatformAccountRepository,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { adminApp, fakeInstagramAuth, TEST_ENCRYPTION_KEY, testDeps } from "../testing/index.js";
import { instagramStateCookieName, tiktokStateCookieName } from "./oauth.js";

// F9-T26: Login Kit de TikTok en la API (spec F9 §4.7): el `state` firmado con la plataforma y el
// corredor, en una cookie `__Host-` con HTTPS, de un solo uso; y el refresco a pedido con la
// renovación que rota. TikTok es un doble: nada sale a la red.

const API = "http://localhost:8787";
const PANEL = "http://localhost:5173";
const NOW = new Date("2026-10-20T12:00:00Z");

/** TikTok falso: canjea el código (`malo…` es invalid_grant; `sin-permiso…`, sin video.upload). */
function fakeTikTokAuth(): TikTokAuth & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    authorizeUrl: (state) =>
      `https://www.tiktok.com/v2/auth/authorize/?client_key=clave&state=${encodeURIComponent(state)}`,
    async exchangeCode(code) {
      calls.push("exchange");
      if (code.startsWith("malo")) {
        throw new AppError("TIKTOK_AUTH_INVALID", "TikTok no aceptó el código de conexión", {
          details: { oauthError: "invalid_grant" },
        });
      }
      return {
        accessToken: `act.${code}`,
        refreshToken: `rft.${code}`,
        openId: "open-id-1",
        scopes: code.startsWith("sin-permiso")
          ? ["user.info.basic"]
          : ["user.info.basic", "video.upload"],
        accessTokenExpiresAt: new Date(NOW.getTime() + 86_400_000),
        refreshTokenExpiresAt: new Date(NOW.getTime() + 365 * 86_400_000),
      };
    },
    async user() {
      calls.push("user");
      return { openId: "open-id-1", displayName: "AgentPey" };
    },
    async refresh(refreshToken) {
      calls.push(`refresh:${refreshToken}`);
      return {
        accessToken: "act.renovado",
        refreshToken: "rft.rotado",
        accessTokenExpiresAt: new Date(NOW.getTime() + 86_400_000),
        refreshTokenExpiresAt: new Date(NOW.getTime() + 365 * 86_400_000),
      };
    },
    isRejected: () => false,
  };
}

function setup(options: { configured?: boolean; secureCookie?: boolean } = {}) {
  const broker = contentBrokerFixture();
  const brokers = createInMemoryBrokerRepository([broker]);
  const platformAccounts = createInMemoryPlatformAccountRepository({ nextId: randomUUID });
  const tiktok = fakeTikTokAuth();
  const secureCookie = options.secureCookie ?? false;
  const app = adminApp(
    testDeps({
      brokers,
      platformAccounts,
      access: { allowedHosts: ["localhost:8787"], allowedOrigins: [PANEL] },
      panelUrl: PANEL,
      instagram: { auth: fakeInstagramAuth(), oauthConfigured: true, secureCookie: false },
      tiktok: {
        auth: tiktok,
        configured: options.configured ?? true,
        secureCookie,
        startUrl: `${API}/api/oauth/tiktok/start`,
      },
      now: () => NOW,
    }),
  );
  const cookieName = tiktokStateCookieName(secureCookie);
  const start = async (slug = broker.slug) => {
    const response = await app.request(`${API}/oauth/tiktok/start?broker=${slug}`);
    const cookie = response.headers.get("set-cookie") ?? "";
    const state = new RegExp(`${cookieName}=([^;]+)`).exec(cookie)?.[1] ?? "";
    return { response, cookie, state: decodeURIComponent(state) };
  };
  const callback = (query: Record<string, string>, cookieState?: string, name = cookieName) =>
    app.request(`${API}/oauth/tiktok/callback?${new URLSearchParams(query)}`, {
      headers:
        cookieState === undefined ? {} : { Cookie: `${name}=${encodeURIComponent(cookieState)}` },
    });
  return { app, broker, platformAccounts, tiktok, start, callback, cookieName };
}

const panelRedirect = (response: Response) => {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(`${PANEL}/cuentas`);
  return Object.fromEntries(location.searchParams);
};

describe("GET /oauth/tiktok/start", () => {
  it("firma el state con la plataforma y el corredor, lo deja en su cookie y manda a TikTok", async () => {
    const { start, tiktok } = setup();
    const { response, cookie, state } = await start();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(tiktok.authorizeUrl(state));
    expect(cookie).toMatch(/^agentsales_oauth_state_tt=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(createStateSigner(TEST_ENCRYPTION_KEY).verify(state)).toMatchObject({
      platform: "tiktok",
      broker: "corredor-inventado",
    });
  });

  it("con HTTPS la cookie es __Host-, Secure y sin Domain", async () => {
    const { cookie } = await setup({ secureCookie: true }).start();
    expect(cookie).toMatch(/^__Host-agentsales_oauth_tt=/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("sin el par de la app, o con un corredor que no existe, vuelve al panel sin cookie", async () => {
    const notConfigured = await setup({ configured: false }).start();
    expect(panelRedirect(notConfigured.response)).toEqual({
      error: "TIKTOK_NOT_CONFIGURED",
      proveedor: "tiktok",
    });
    expect(notConfigured.response.headers.get("set-cookie")).toBeNull();

    const missing = await setup().start("no-existe");
    expect(panelRedirect(missing.response)).toEqual({
      error: "BROKER_NOT_FOUND",
      proveedor: "tiktok",
    });
    expect(missing.response.headers.get("set-cookie")).toBeNull();
  });
});

describe("GET /oauth/tiktok/callback", () => {
  it("con el state y su cookie canjea, guarda el par cifrado y vuelve al panel", async () => {
    const t = setup();
    const { state } = await t.start();

    const response = await t.callback({ code: "codigo-1", state, scopes: "video.upload" }, state);

    expect(panelRedirect(response)).toEqual({ conectada: "tiktok", proveedor: "tiktok" });
    expect(t.tiktok.calls).toEqual(["exchange", "user"]);
    const [account] = await t.platformAccounts.list(ALL_SCOPE);
    expect(account).toMatchObject({
      platform: "tiktok",
      externalAccountId: "open-id-1",
      displayName: "AgentPey",
      status: "connected",
    });
    expect(t.platformAccounts.storedCredentials(account?.id ?? "")).toEqual({
      accessToken: "act.codigo-1",
      refreshToken: "rft.codigo-1",
    });
    expect(response.headers.get("set-cookie")).toContain(`${t.cookieName}=;`);
    expect(response.headers.get("location")).not.toMatch(/codigo-1|act\.|rft\./);
  });

  it("el state es de un solo uso: la misma vuelta otra vez (aun con su cookie) no canjea", async () => {
    const t = setup();
    const { state } = await t.start();
    await t.callback({ code: "codigo-1", state }, state);

    const again = await t.callback({ code: "codigo-1", state }, state);

    expect(panelRedirect(again)).toEqual({ error: "OAUTH_STATE_INVALID", proveedor: "tiktok" });
    expect(t.tiktok.calls).toEqual(["exchange", "user"]);
  });

  it("sin cookie, con otra cookie o con el state de otra red no llama a TikTok", async () => {
    const t = setup();
    const { state } = await t.start();
    const instagramState = createStateSigner(TEST_ENCRYPTION_KEY).sign(
      { platform: "instagram", broker: t.broker.slug },
      { ttlSeconds: 600 },
    );

    for (const response of [
      await t.callback({ code: "c", state }),
      await t.callback({ code: "c", state }, "otro-state"),
      await t.callback({ code: "c", state: instagramState }, instagramState),
      await t.callback(
        { code: "c", state: instagramState },
        instagramState,
        instagramStateCookieName(false),
      ),
    ]) {
      expect(panelRedirect(response)).toEqual({
        error: "OAUTH_STATE_INVALID",
        proveedor: "tiktok",
      });
    }
    expect(t.tiktok.calls).toEqual([]);
  });

  it("si el operador rechaza en TikTok: OAUTH_DENIED, sin canjear", async () => {
    const t = setup();
    const { state } = await t.start();
    const response = await t.callback({ error: "access_denied", state }, state);
    expect(panelRedirect(response)).toEqual({ error: "OAUTH_DENIED", proveedor: "tiktok" });
    expect(t.tiktok.calls).toEqual([]);
  });

  it("sin video.upload, o con un código vencido, vuelve con el código del error y no guarda nada", async () => {
    const t = setup();
    const first = await t.start();
    const denied = await t.callback({ code: "sin-permiso", state: first.state }, first.state);
    expect(panelRedirect(denied)).toEqual({
      error: "TIKTOK_PERMISSION_DENIED",
      proveedor: "tiktok",
    });

    const second = await t.start();
    const expired = await t.callback({ code: "malo", state: second.state }, second.state);
    expect(panelRedirect(expired)).toEqual({ error: "TIKTOK_AUTH_INVALID", proveedor: "tiktok" });
    await expect(t.platformAccounts.list(ALL_SCOPE)).resolves.toEqual([]);
  });
});

describe("/accounts con TikTok", () => {
  it("la lista dice si TikTok está configurado y dónde empieza su OAuth", async () => {
    const t = setup();
    const response = await t.app.request(`${API}/accounts`);
    const body = (await response.json()) as { connect: { tiktok?: unknown } };
    expect(body.connect.tiktok).toEqual({
      configured: true,
      startUrl: `${API}/api/oauth/tiktok/start`,
    });
  });

  it("el refresco a pedido renueva con la renovación que rota", async () => {
    const t = setup();
    const account = await t.platformAccounts.upsertConnected({
      brokerId: t.broker.id,
      platform: "tiktok",
      externalAccountId: "open-id-1",
      displayName: "AgentPey",
      tokenExpiresAt: new Date(NOW.getTime() + 300 * 86_400_000),
      meta: { openId: "open-id-1", scopes: [], accessTokenExpiresAt: NOW.toISOString() },
      credentials: { accessToken: "act.viejo", refreshToken: "rft.viejo" },
    });

    const response = await t.app.request(`${API}/accounts/${account.id}/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: PANEL },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "refreshed" });
    expect(t.tiktok.calls).toEqual(["refresh:rft.viejo"]);
    expect(t.platformAccounts.storedCredentials(account.id)).toEqual({
      accessToken: "act.renovado",
      refreshToken: "rft.rotado",
    });
  });
});
