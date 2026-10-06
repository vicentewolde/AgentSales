import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createLogger, createStateSigner } from "@agentsales/config";
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

describe("OAuth · seguridad", () => {
  /** Un logger que guarda cada línea, para revisar que no se filtre nada. */
  function capturing() {
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

  it("el corredor sale del state firmado: una query que nombra a otro no lo cambia", async () => {
    const own = contentBrokerFixture();
    const other = { ...contentBrokerFixture(), id: randomUUID(), slug: "otro-corredor" };
    const brokers = createInMemoryBrokerRepository([own, other]);
    const platformAccounts = createInMemoryPlatformAccountRepository({ nextId: randomUUID });
    const app = createApp(
      testDeps({
        brokers,
        platformAccounts,
        access: { allowedHosts: ["localhost:8787"], allowedOrigins: [PANEL] },
        panelUrl: PANEL,
      }),
    );
    const start = await app.request(`${API}/oauth/instagram/start?broker=${other.slug}`);
    const state = decodeURIComponent(
      /agentsales_oauth_state=([^;]+)/.exec(start.headers.get("set-cookie") ?? "")?.[1] ?? "",
    );
    const response = await app.request(
      `${API}/oauth/instagram/callback?${new URLSearchParams({ code: "AQB", state, broker: own.slug })}`,
      { headers: { Cookie: `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}` } },
    );
    expect(panelRedirect(response)).toEqual({ conectada: "instagram" });
    const [account] = await platformAccounts.list();
    expect(account?.brokerId).toBe(other.id);
  });

  it("un state válido sin corredor es OAUTH_STATE_INVALID; uno de un corredor que no existe, BROKER_NOT_FOUND", async () => {
    const { callback, auth } = setup();
    const signer = createStateSigner(TEST_ENCRYPTION_KEY);
    const withoutBroker = signer.sign({ otro: "dato" }, { ttlSeconds: 600 });
    expect(
      panelRedirect(await callback({ code: "c", state: withoutBroker }, withoutBroker)),
    ).toEqual({ error: "OAUTH_STATE_INVALID" });
    expect(auth.calls).toEqual([]);
    const ghost = signer.sign({ broker: "ya-no-existe" }, { ttlSeconds: 600 });
    expect(panelRedirect(await callback({ code: "c", state: ghost }, ghost))).toEqual({
      error: "BROKER_NOT_FOUND",
    });
  });

  it("sin el par de la app, la vuelta no canjea (INSTAGRAM_NOT_CONFIGURED)", async () => {
    const { callback, auth } = setup({ oauthConfigured: false });
    const state = createStateSigner(TEST_ENCRYPTION_KEY).sign(
      { broker: "corredor-inventado" },
      { ttlSeconds: 600 },
    );
    expect(panelRedirect(await callback({ code: "c", state }, state))).toEqual({
      error: "INSTAGRAM_NOT_CONFIGURED",
    });
    expect(auth.calls).toEqual([]);
  });

  it("la cookie se borra con su Path (y Secure si corresponde)", async () => {
    for (const secureCookie of [false, true]) {
      const { start, callback } = setup({ secureCookie });
      const { state } = await start();
      const deleted = (await callback({ code: "AQB", state }, state)).headers.get("set-cookie");
      expect(deleted).toMatch(/agentsales_oauth_state=;/);
      expect(deleted).toMatch(/Path=\/oauth/);
      expect(deleted).toMatch(/Max-Age=0/);
      if (secureCookie) expect(deleted).toMatch(/Secure/);
    }
  });

  it("las rutas del OAuth rechazan otro Host (403)", async () => {
    const { app, broker } = setup();
    const response = await app.request(
      `http://evil.test:8787/oauth/instagram/start?broker=${broker.slug}`,
    );
    expect(response.status).toBe(403);
  });

  it("ni el código ni el token del canje llegan al log ni a la URL de vuelta", async () => {
    const { logger, lines } = capturing();
    const broker = contentBrokerFixture();
    const app = createApp(
      testDeps({
        brokers: createInMemoryBrokerRepository([broker]),
        logger,
        access: { allowedHosts: ["localhost:8787"], allowedOrigins: [PANEL] },
        panelUrl: PANEL,
      }),
    );
    const start = await app.request(`${API}/oauth/instagram/start?broker=${broker.slug}`);
    const state = decodeURIComponent(
      /agentsales_oauth_state=([^;]+)/.exec(start.headers.get("set-cookie") ?? "")?.[1] ?? "",
    );
    for (const code of ["AQB-codigo-secreto", "malo-codigo-secreto"]) {
      const response = await app.request(
        `${API}/oauth/instagram/callback?${new URLSearchParams({ code, state })}`,
        { headers: { Cookie: `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}` } },
      );
      expect(response.headers.get("location")).not.toContain("codigo-secreto");
    }
    const written = lines.join("\n");
    expect(written).not.toContain("codigo-secreto");
    expect(written).not.toContain("IGAA-largo");
    expect(written).not.toContain(state);
  });
});
