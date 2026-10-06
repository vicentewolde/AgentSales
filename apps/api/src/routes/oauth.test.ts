import { randomUUID } from "node:crypto";
import { createStateSigner } from "@agentsales/config";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryPlatformAccountRepository,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { fakeInstagramAuth, TEST_ENCRYPTION_KEY, testDeps } from "../testing/index.js";
import { OAUTH_STATE_COOKIE } from "./oauth.js";

const API = "http://localhost:8787";
const PANEL = "http://localhost:5173";

function setup(options: { oauthConfigured?: boolean; secureCookie?: boolean } = {}) {
  const broker = contentBrokerFixture();
  const brokers = createInMemoryBrokerRepository([broker]);
  const platformAccounts = createInMemoryPlatformAccountRepository({ nextId: randomUUID });
  const auth = fakeInstagramAuth();
  const app = createApp(
    testDeps({
      brokers,
      platformAccounts,
      access: { allowedHosts: ["localhost:8787"], allowedOrigins: [PANEL] },
      panelUrl: PANEL,
      instagram: {
        auth,
        oauthConfigured: options.oauthConfigured ?? true,
        secureCookie: options.secureCookie ?? false,
      },
    }),
  );
  /** Empieza el OAuth y devuelve el `state` de la cookie y adónde manda a Instagram. */
  const start = async () => {
    const response = await app.request(`${API}/oauth/instagram/start?broker=${broker.slug}`);
    const cookie = response.headers.get("set-cookie") ?? "";
    const state = /agentsales_oauth_state=([^;]+)/.exec(cookie)?.[1] ?? "";
    return { response, cookie, state: decodeURIComponent(state) };
  };
  const callback = (query: Record<string, string>, cookieState?: string) =>
    app.request(`${API}/oauth/instagram/callback?${new URLSearchParams(query)}`, {
      headers:
        cookieState === undefined
          ? {}
          : { Cookie: `${OAUTH_STATE_COOKIE}=${encodeURIComponent(cookieState)}` },
    });
  return { app, broker, platformAccounts, auth, start, callback };
}

const panelRedirect = (response: Response) => {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(`${PANEL}/cuentas`);
  return Object.fromEntries(location.searchParams);
};

describe("GET /oauth/instagram/start", () => {
  it("firma el state, lo deja en una cookie HttpOnly, SameSite=Lax y Path=/oauth, y manda a Instagram", async () => {
    const { start, auth } = setup();
    const { response, cookie, state } = await start();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(auth.authorizeUrl(state));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/oauth/);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(cookie).not.toMatch(/Secure/);
    expect(createStateSigner(TEST_ENCRYPTION_KEY).verify(state)).toMatchObject({
      broker: "corredor-inventado",
    });
  });

  it("con la URI https la cookie va Secure", async () => {
    const { cookie } = await setup({ secureCookie: true }).start();
    expect(cookie).toMatch(/Secure/);
  });

  it("sin el par de la app, o con un corredor que no existe, vuelve al panel con su código", async () => {
    const notConfigured = await setup({ oauthConfigured: false }).start();
    expect(panelRedirect(notConfigured.response)).toEqual({ error: "INSTAGRAM_NOT_CONFIGURED" });

    const { app } = setup();
    const response = await app.request(`${API}/oauth/instagram/start?broker=no-existe`);
    expect(panelRedirect(response)).toEqual({ error: "BROKER_NOT_FOUND" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("GET /oauth/instagram/callback", () => {
  it("con el state correcto canjea el código (sin el #_), guarda la cuenta cifrada y vuelve al panel", async () => {
    const { start, callback, platformAccounts, auth } = setup();
    const { state } = await start();
    const response = await callback({ code: "AQB-codigo#_", state }, state);

    expect(panelRedirect(response)).toEqual({ conectada: "instagram" });
    expect(response.headers.get("location")).not.toContain("corredora");
    expect(response.headers.get("set-cookie")).toMatch(/agentsales_oauth_state=;.*Max-Age=0/);
    const [account] = await platformAccounts.list();
    expect(account).toMatchObject({
      status: "connected",
      displayName: "@corredora",
      meta: {
        tokenExpiryEstimated: false,
        permissions: expect.arrayContaining(["instagram_business_content_publish"]),
      },
    });
    expect(platformAccounts.storedCredentials(account?.id ?? "")).toEqual({
      accessToken: "IGAA-largo-AQB-codigo#_",
    });
    expect(auth.calls).toEqual(["exchange", "me"]);
  });

  it("con otro state, sin cookie o vencido: OAUTH_STATE_INVALID sin llamar a Instagram", async () => {
    const { start, callback, auth, platformAccounts } = setup();
    const { state } = await start();
    const otherSigner = createStateSigner(TEST_ENCRYPTION_KEY);
    const expired = otherSigner.sign(
      { broker: "corredor-inventado" },
      { ttlSeconds: 600, now: new Date(Date.now() - 20 * 60 * 1000) },
    );
    const forged = createStateSigner("otra-clave-de-32-caracteres-o-mas-0123456789").sign(
      { broker: "corredor-inventado" },
      { ttlSeconds: 600 },
    );
    for (const [query, cookie] of [
      [{ code: "c", state }, undefined],
      [{ code: "c", state }, "otro-state"],
      [{ code: "c", state: expired }, expired],
      [{ code: "c", state: forged }, forged],
      [{ code: "c" }, state],
    ] as const) {
      const response = await callback(query, cookie);
      expect(panelRedirect(response)).toEqual({ error: "OAUTH_STATE_INVALID" });
    }
    expect(auth.calls).toEqual([]);
    expect(await platformAccounts.list()).toEqual([]);
  });

  it("si el operador rechaza en Instagram vuelve con OAUTH_DENIED, sin llamar a Instagram", async () => {
    const { start, callback, auth } = setup();
    const { state } = await start();
    const response = await callback(
      { error: "access_denied", error_reason: "user_denied", state },
      state,
    );
    expect(panelRedirect(response)).toEqual({ error: "OAUTH_DENIED" });
    expect(auth.calls).toEqual([]);
  });

  it("sin el permiso de publicar vuelve con IG_PERMISSION_DENIED y no guarda la cuenta", async () => {
    const { start, callback, platformAccounts } = setup();
    const { state } = await start();
    const response = await callback({ code: "codigo-sin-publicar", state }, state);
    expect(panelRedirect(response)).toEqual({ error: "IG_PERMISSION_DENIED" });
    expect(await platformAccounts.list()).toEqual([]);
  });

  it("un código vencido vuelve con su código de error, sin el código en la URL", async () => {
    const { start, callback } = setup();
    const { state } = await start();
    const response = await callback({ code: "malo-AQB", state }, state);
    expect(panelRedirect(response)).toEqual({ error: "IG_AUTH_INVALID" });
    expect(response.headers.get("location")).not.toContain("malo-AQB");
  });

  it("sin código vuelve con OAUTH_CODE_MISSING", async () => {
    const { start, callback } = setup();
    const { state } = await start();
    expect(panelRedirect(await callback({ state }, state))).toEqual({
      error: "OAUTH_CODE_MISSING",
    });
  });

  it("el state sirve una sola vez: la cookie se borra y repetir la vuelta no conecta", async () => {
    const { start, callback, auth } = setup();
    const { state } = await start();
    await callback({ code: "AQB", state }, state);
    // El navegador ya no manda la cookie: sin ella, OAUTH_STATE_INVALID.
    expect(panelRedirect(await callback({ code: "AQB", state }))).toEqual({
      error: "OAUTH_STATE_INVALID",
    });
    expect(auth.calls).toEqual(["exchange", "me"]);
  });
});
