import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createLogger, createStateSigner } from "@agentsales/config";
import { ALL_SCOPE } from "@agentsales/core";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryPlatformAccountRepository,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import {
  adminApp,
  fakeLinkedInAuth,
  TEST_ENCRYPTION_KEY,
  testAuth,
  testDeps,
} from "../testing/index.js";
import { linkedinStateCookieName } from "./oauth.js";

// F9-T15: el OAuth del perfil personal de LinkedIn (spec F9 §4.7): `state` firmado con la
// plataforma y la marca, en su cookie, y de un solo uso.

const API = "http://localhost:8787";
const PANEL = "http://localhost:5173";

function capturingLogger() {
  const lines: string[] = [];
  const logger = createLogger(
    { level: "debug" },
    new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    }),
  );
  return { logger, lines };
}

function setup(options: { configured?: boolean; secureCookie?: boolean } = {}) {
  const broker = contentBrokerFixture();
  const other = { ...contentBrokerFixture(), id: randomUUID(), slug: "otra-marca" };
  const brokers = createInMemoryBrokerRepository([broker, other]);
  const platformAccounts = createInMemoryPlatformAccountRepository({ nextId: randomUUID });
  const auth = fakeLinkedInAuth();
  const { logger, lines } = capturingLogger();
  const secure = options.secureCookie ?? false;
  const app = adminApp(
    testDeps({
      brokers,
      platformAccounts,
      logger,
      access: { allowedHosts: ["localhost:8787"], allowedOrigins: [PANEL] },
      panelUrl: PANEL,
      linkedin: {
        auth,
        configured: options.configured ?? true,
        secureCookie: secure,
        startUrl: `${API}/api/oauth/linkedin/start`,
      },
    }),
  );
  const cookieName = linkedinStateCookieName(secure);
  const start = async (slug: string = broker.slug) => {
    const response = await app.request(`${API}/oauth/linkedin/start?broker=${slug}`);
    const cookie = response.headers.get("set-cookie") ?? "";
    const state = new RegExp(`${cookieName}=([^;]+)`).exec(cookie)?.[1] ?? "";
    return { response, cookie, state: decodeURIComponent(state) };
  };
  const callback = (query: Record<string, string>, cookieState?: string) =>
    app.request(`${API}/oauth/linkedin/callback?${new URLSearchParams(query)}`, {
      headers:
        cookieState === undefined
          ? {}
          : { Cookie: `${cookieName}=${encodeURIComponent(cookieState)}` },
    });
  return { app, broker, other, platformAccounts, auth, start, callback, lines };
}

const panelRedirect = (response: Response) => {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(`${PANEL}/cuentas`);
  return Object.fromEntries(location.searchParams);
};

describe("GET /oauth/linkedin/start", () => {
  it("firma el state, lo deja en una cookie HttpOnly, Lax y Path=/, y manda a LinkedIn", async () => {
    const { start, auth } = setup();
    const { response, cookie, state } = await start();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(auth.authorizeUrl(state));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/);
    expect(cookie).toContain("agentsales_oauth_state_li=");
    // La plataforma y la marca van firmadas en el state.
    expect(createStateSigner(TEST_ENCRYPTION_KEY).verify(state)).toMatchObject({
      platform: "linkedin",
      broker: "corredor-inventado",
    });
  });

  it("con HTTPS la cookie es __Host-agentsales_oauth_li y Secure", async () => {
    const { cookie } = await setup({ secureCookie: true }).start();
    expect(cookie).toMatch(/^__Host-agentsales_oauth_li=/);
    expect(cookie).toMatch(/Secure/);
  });

  it("sin el par de la app vuelve con LINKEDIN_NOT_CONFIGURED; un corredor que no existe, BROKER_NOT_FOUND", async () => {
    const off = await setup({ configured: false }).start();
    expect(panelRedirect(off.response)).toEqual({
      error: "LINKEDIN_NOT_CONFIGURED",
      proveedor: "linkedin",
    });
    const missing = await setup().start("no-existe");
    expect(panelRedirect(missing.response)).toEqual({
      error: "BROKER_NOT_FOUND",
      proveedor: "linkedin",
    });
    expect(missing.cookie).toBe("");
  });
});

describe("GET /oauth/linkedin/start · el corredor (linkedin.connect)", () => {
  const TOKEN = "token-del-corredor";

  async function brokerSetup() {
    const mine = contentBrokerFixture({ id: randomUUID(), slug: "mio" });
    const theirs = contentBrokerFixture({ id: randomUUID(), slug: "ajeno" });
    const brokers = createInMemoryBrokerRepository([mine, theirs]);
    const deps = testDeps({
      brokers,
      access: { allowedHosts: ["localhost:8787"], allowedOrigins: [PANEL] },
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
    return (slug: string, token: string | null = TOKEN) =>
      app.request(`${API}/oauth/linkedin/start?broker=${slug}`, {
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      });
  }

  it("conecta el suyo; el de otro responde como uno que no existe; sin sesión, 401", async () => {
    const start = await brokerSetup();
    const own = await start("mio");
    expect(own.status).toBe(302);
    expect(own.headers.get("location")).toContain("linkedin.com");
    const theirs = await start("ajeno");
    expect(panelRedirect(theirs)).toEqual({ error: "BROKER_NOT_FOUND", proveedor: "linkedin" });
    expect(theirs.headers.get("set-cookie")).toBeNull();
    expect((await start("mio", null)).status).toBe(401);
  });
});

describe("GET /oauth/linkedin/callback", () => {
  it("con el state correcto canjea, guarda la cuenta en modo manual (60 días) y vuelve al panel", async () => {
    const { start, callback, platformAccounts, auth, broker } = setup();
    const { state } = await start();

    const response = await callback({ code: "AQT-codigo", state }, state);

    expect(panelRedirect(response)).toEqual({ conectada: "linkedin", proveedor: "linkedin" });
    expect(auth.calls).toEqual(["exchangeCode", "me"]);
    const [account] = await platformAccounts.list(ALL_SCOPE);
    expect(account).toMatchObject({
      brokerId: broker.id,
      platform: "linkedin",
      externalAccountId: "miembro-123",
      displayName: "Vicente Wolde",
      status: "connected",
      tokenExpiresAt: new Date("2026-12-19T12:00:00Z"),
      meta: { mode: "manual" },
    });
    expect(await platformAccounts.getCredentials(account?.id ?? "")).toEqual({
      accessToken: "token-linkedin-de-prueba",
    });
  });

  it("el state es de un solo uso: repetir la vuelta, aun con su cookie, no canjea de nuevo", async () => {
    const { start, callback, auth } = setup();
    const { state } = await start();
    expect(panelRedirect(await callback({ code: "AQT-1", state }, state))).toMatchObject({
      conectada: "linkedin",
    });
    expect(panelRedirect(await callback({ code: "AQT-2", state }, state))).toEqual({
      error: "OAUTH_STATE_INVALID",
      proveedor: "linkedin",
    });
    expect(auth.calls).toEqual(["exchangeCode", "me"]);
  });

  it("la vuelta borra la cookie pase lo que pase", async () => {
    const { start, callback } = setup();
    const { state } = await start();
    const response = await callback({ error: "user_cancelled_authorize", state }, state);
    expect(panelRedirect(response)).toEqual({ error: "OAUTH_DENIED", proveedor: "linkedin" });
    expect(response.headers.get("set-cookie")).toMatch(/agentsales_oauth_state_li=;.*Max-Age=0/);
  });

  it("va amarrado a la marca: el corredor sale del state firmado, no de la query", async () => {
    const { start, callback, platformAccounts, other, broker } = setup();
    const { state } = await start(other.slug);
    await callback({ code: "AQT", state, broker: broker.slug }, state);
    const [account] = await platformAccounts.list(ALL_SCOPE);
    expect(account?.brokerId).toBe(other.id);
  });

  it("sin cookie, con otra, vencido, de otra plataforma o sin marca: OAUTH_STATE_INVALID sin llamar a LinkedIn", async () => {
    const { start, callback, auth } = setup();
    const { state } = await start();
    const signer = createStateSigner(TEST_ENCRYPTION_KEY);
    const instagram = signer.sign(
      { platform: "instagram", broker: "corredor-inventado" },
      { ttlSeconds: 600 },
    );
    const noBroker = signer.sign({ platform: "linkedin" }, { ttlSeconds: 600 });
    const expired = signer.sign(
      { platform: "linkedin", broker: "corredor-inventado" },
      { ttlSeconds: 60, now: new Date(Date.now() - 3_600_000) },
    );
    const cases: Array<[string, string | undefined]> = [
      [state, undefined],
      [state, `${state}x`],
      [instagram, instagram],
      [noBroker, noBroker],
      [expired, expired],
    ];
    for (const [query, cookie] of cases) {
      expect(panelRedirect(await callback({ code: "AQT", state: query }, cookie))).toEqual({
        error: "OAUTH_STATE_INVALID",
        proveedor: "linkedin",
      });
    }
    expect(auth.calls).toEqual([]);
  });

  it("sin el permiso de publicar vuelve con LINKEDIN_PERMISSION_DENIED y no guarda nada", async () => {
    const { start, callback, platformAccounts } = setup();
    const { state } = await start();
    expect(panelRedirect(await callback({ code: "sin-permiso", state }, state))).toEqual({
      error: "LINKEDIN_PERMISSION_DENIED",
      proveedor: "linkedin",
    });
    expect(await platformAccounts.list(ALL_SCOPE)).toEqual([]);
  });

  it("sin código: OAUTH_CODE_MISSING; ni el código ni el token llegan al log ni a la URL", async () => {
    const { start, callback, lines } = setup();
    const first = await start();
    expect(panelRedirect(await callback({ state: first.state }, first.state))).toEqual({
      error: "OAUTH_CODE_MISSING",
      proveedor: "linkedin",
    });
    const second = await start();
    const response = await callback(
      { code: "malo-codigo-secreto", state: second.state },
      second.state,
    );
    expect(panelRedirect(response)).toEqual({
      error: "LINKEDIN_AUTH_INVALID",
      proveedor: "linkedin",
    });
    const written = lines.join("\n");
    expect(written).not.toContain("codigo-secreto");
    expect(written).not.toContain("token-linkedin-de-prueba");
    expect(written).not.toContain(second.state);
  });
});
