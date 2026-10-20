import { randomUUID } from "node:crypto";
import { createStateSigner } from "@agentsales/config";
import { xSpendLimitOf } from "@agentsales/core";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryPlatformAccountRepository,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import {
  accountListResponseSchema,
  accountResponseSchema,
  errorBodySchema,
} from "../contracts/index.js";
import {
  adminApp,
  fakeXAuth,
  TEST_ENCRYPTION_KEY,
  TEST_PKCE_VERIFIER,
  testAuth,
  testDeps,
} from "../testing/index.js";
import { xStateCookieName } from "./oauth.js";

// F9-T16 (spec F9 §4.7): el OAuth 2.0 con PKCE de X. El `state` va en la URL, firmado y de un solo
// uso; el verificador de PKCE va solo en la cookie firmada (nunca en la URL ni en la base).

const API = "http://127.0.0.1:8787";
const PANEL = "http://127.0.0.1:5173";

function setup(options: { configured?: boolean; secureCookie?: boolean } = {}) {
  const broker = contentBrokerFixture();
  const brokers = createInMemoryBrokerRepository([broker]);
  const platformAccounts = createInMemoryPlatformAccountRepository({ nextId: randomUUID });
  const auth = fakeXAuth();
  const app = adminApp(
    testDeps({
      brokers,
      platformAccounts,
      access: { allowedHosts: ["127.0.0.1:8787"], allowedOrigins: [PANEL] },
      panelUrl: PANEL,
      x: {
        auth,
        configured: options.configured ?? true,
        secureCookie: options.secureCookie ?? false,
        pkce: () => ({ verifier: TEST_PKCE_VERIFIER, challenge: "desafio-s256" }),
        startUrl: `${API}/api/oauth/x/start`,
      },
    }),
  );
  const cookieName = xStateCookieName(options.secureCookie ?? false);
  /** Empieza el OAuth: la cookie firmada y el `state` que va en la URL de X. */
  const start = async (slug = broker.slug) => {
    const response = await app.request(`${API}/oauth/x/start?broker=${slug}`);
    const setCookie = response.headers.get("set-cookie") ?? "";
    const sealed = decodeURIComponent(
      new RegExp(`${cookieName}=([^;]+)`).exec(setCookie)?.[1] ?? "",
    );
    const location = response.headers.get("location") ?? "";
    const state = location === "" ? "" : (new URL(location).searchParams.get("state") ?? "");
    return { response, setCookie, sealed, state, location };
  };
  const callback = (query: Record<string, string>, sealed?: string) =>
    app.request(`${API}/oauth/x/callback?${new URLSearchParams(query)}`, {
      headers:
        sealed === undefined ? {} : { Cookie: `${cookieName}=${encodeURIComponent(sealed)}` },
    });
  return { app, broker, platformAccounts, auth, start, callback };
}

const panelRedirect = (response: Response) => {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(`${PANEL}/cuentas`);
  return Object.fromEntries(location.searchParams);
};

describe("GET /oauth/x/start", () => {
  it("manda a X con el state y el desafío S256; el verificador va solo en la cookie firmada", async () => {
    const { start } = setup();
    const { response, setCookie, sealed, state, location } = await start();
    expect(response.status).toBe(302);
    expect(location).toContain("code_challenge=desafio-s256");
    expect(location).not.toContain(TEST_PKCE_VERIFIER);
    expect(setCookie).toMatch(/^agentsales_oauth_state_x=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Max-Age=600/);
    const signer = createStateSigner(TEST_ENCRYPTION_KEY);
    const urlState = signer.verify(state);
    expect(urlState).toMatchObject({ platform: "x", broker: "corredor-inventado" });
    expect(JSON.stringify(urlState)).not.toContain(TEST_PKCE_VERIFIER);
    expect(signer.verify(sealed)).toMatchObject({
      platform: "x_pkce",
      broker: "corredor-inventado",
      stateNonce: urlState.nonce,
      verifier: TEST_PKCE_VERIFIER,
    });
  });

  it("con HTTPS la cookie es __Host-, Secure y sin Domain", async () => {
    const { setCookie } = await setup({ secureCookie: true }).start();
    expect(setCookie).toMatch(/^__Host-agentsales_oauth_x=/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).not.toMatch(/Domain=/i);
  });

  it("sin el par de la app o con un corredor que no existe vuelve al panel sin cookie", async () => {
    const notConfigured = await setup({ configured: false }).start();
    expect(panelRedirect(notConfigured.response)).toEqual({
      error: "X_NOT_CONFIGURED",
      proveedor: "x",
    });
    const missing = await setup().start("no-existe");
    expect(panelRedirect(missing.response)).toEqual({ error: "BROKER_NOT_FOUND", proveedor: "x" });
    expect(missing.setCookie).toBe("");
  });

  it("un corredor conecta la suya (x.connect) y no la de otro; sin sesión, 401", async () => {
    const TOKEN = "token-del-corredor";
    const mine = contentBrokerFixture({ id: randomUUID(), slug: "mio" });
    const theirs = contentBrokerFixture({ id: randomUUID(), slug: "ajeno" });
    const brokers = createInMemoryBrokerRepository([mine, theirs]);
    const deps = testDeps({
      brokers,
      access: { allowedHosts: ["127.0.0.1:8787"], allowedOrigins: [PANEL] },
      panelUrl: PANEL,
    });
    const auth = testAuth();
    deps.auth = { ...auth, brokers: deps.brokers };
    const stored = await brokers.findBySlug("mio");
    if (stored === null) throw new Error("falta el corredor de prueba");
    const user = auth.repos.seed.user({
      email: "corredor@ejemplo.cl",
      name: "Corredor",
      role: "broker",
      brokerId: stored.id,
    });
    auth.repos.seed.session({
      userId: user.id,
      tokenHash: auth.tokens.hash(TOKEN),
      client: "panel",
    });
    const app = createApp(deps);
    const request = (slug: string, token: string | null = TOKEN) =>
      app.request(`${API}/oauth/x/start?broker=${slug}`, {
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      });
    const own = await request("mio");
    expect(own.status).toBe(302);
    expect(own.headers.get("location")).toContain("https://x.com/i/oauth2/authorize");
    const other = await request("ajeno");
    expect(panelRedirect(other)).toEqual({ error: "BROKER_NOT_FOUND", proveedor: "x" });
    expect(other.headers.get("set-cookie")).toBeNull();
    expect((await request("mio", null)).status).toBe(401);
  });
});

describe("GET /oauth/x/callback", () => {
  it("canjea con el verificador de la cookie y conecta la cuenta (de un solo uso)", async () => {
    const { start, callback, auth, platformAccounts } = setup();
    const { sealed, state } = await start();
    const response = await callback({ code: "codigo-1", state }, sealed);
    expect(panelRedirect(response)).toEqual({ conectada: "x", proveedor: "x" });
    expect(auth.calls).toEqual([{ code: "codigo-1", verifier: TEST_PKCE_VERIFIER }]);
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    const [account] = await platformAccounts.list({ kind: "all" });
    expect(account).toMatchObject({ platform: "x", status: "connected", displayName: "@agentpey" });
    expect(account === undefined ? null : xSpendLimitOf(account)).toBe(10);
    expect(await platformAccounts.getCredentials(account?.id ?? "")).toEqual({
      accessToken: "access-codigo-1",
      refreshToken: "refresh-codigo-1",
    });
    // Repetir la vuelta (aun con la cookie) no canjea otra vez.
    const again = await callback({ code: "codigo-1", state }, sealed);
    expect(panelRedirect(again)).toEqual({ error: "OAUTH_STATE_INVALID", proveedor: "x" });
    expect(auth.calls).toHaveLength(1);
  });

  it("sin cookie, con la cookie de otro state o con un state de otra plataforma no llama a X", async () => {
    const { start, callback, auth } = setup();
    const first = await start();
    const second = await start();
    expect(panelRedirect(await callback({ code: "c", state: first.state }))).toEqual({
      error: "OAUTH_STATE_INVALID",
      proveedor: "x",
    });
    expect(panelRedirect(await callback({ code: "c", state: first.state }, second.sealed))).toEqual(
      { error: "OAUTH_STATE_INVALID", proveedor: "x" },
    );
    const instagramState = createStateSigner(TEST_ENCRYPTION_KEY).sign(
      { platform: "instagram", broker: "corredor-inventado" },
      { ttlSeconds: 600 },
    );
    expect(
      panelRedirect(await callback({ code: "c", state: instagramState }, first.sealed)),
    ).toEqual({ error: "OAUTH_STATE_INVALID", proveedor: "x" });
    expect(auth.calls).toEqual([]);
  });

  it("el rechazo del operador, un código que falta y un canje que falla vuelven al panel", async () => {
    const { start, callback } = setup();
    expect(panelRedirect(await callback({ error: "access_denied" }))).toEqual({
      error: "OAUTH_DENIED",
      proveedor: "x",
    });
    const { sealed, state } = await start();
    expect(panelRedirect(await callback({ state }, sealed))).toEqual({
      error: "OAUTH_CODE_MISSING",
      proveedor: "x",
    });
    const other = await start();
    expect(
      panelRedirect(await callback({ code: "sin-permisos", state: other.state }, other.sealed)),
    ).toEqual({ error: "X_PERMISSION_MISSING", proveedor: "x" });
  });
});

describe("GET /accounts y POST /accounts/:id/spend-limit (X)", () => {
  it("informa cómo conectar X y el administrador fija el tope de gasto", async () => {
    const { app, start, callback, platformAccounts } = setup();
    const list = accountListResponseSchema.parse(
      await (await app.request(`${API}/accounts`)).json(),
    );
    expect(list.connect.x).toEqual({
      configured: true,
      startUrl: `${API}/api/oauth/x/start`,
    });
    const { sealed, state } = await start();
    await callback({ code: "codigo-2", state }, sealed);
    const [account] = await platformAccounts.list({ kind: "all" });
    const response = await app.request(`${API}/accounts/${account?.id}/spend-limit`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: PANEL },
      body: JSON.stringify({ spendLimitUsd: 2.5 }),
    });
    expect(response.status).toBe(200);
    expect(accountResponseSchema.parse(await response.json()).account).toMatchObject({
      platform: "x",
      spendLimitUsd: 2.5,
    });
    const invalid = await app.request(`${API}/accounts/${account?.id}/spend-limit`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: PANEL },
      body: JSON.stringify({ spendLimitUsd: -3 }),
    });
    expect(invalid.status).toBe(400);
    expect(errorBodySchema.parse(await invalid.json()).error.code).toBe("X_SPEND_LIMIT_INVALID");
  });
});
