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
import {
  adminApp,
  fakeInstagramAuth,
  fakeMercadoLibreAuth,
  TEST_ENCRYPTION_KEY,
  TEST_ML_REDIRECT_URI,
  testDeps,
} from "../testing/index.js";
import {
  instagramStartUrlOf,
  instagramStateCookieName,
  mercadoLibreStateCookieName,
  OAUTH_STATE_COOKIE,
} from "./oauth.js";

const API = "http://localhost:8787";
const PANEL = "http://localhost:5173";

function setup(options: { oauthConfigured?: boolean; secureCookie?: boolean } = {}) {
  const broker = contentBrokerFixture();
  const brokers = createInMemoryBrokerRepository([broker]);
  const platformAccounts = createInMemoryPlatformAccountRepository({ nextId: randomUUID });
  const auth = fakeInstagramAuth();
  const app = adminApp(
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
  const cookieName = instagramStateCookieName(options.secureCookie ?? false);
  /** Empieza el OAuth y devuelve el `state` de la cookie y adónde manda a Instagram. */
  const start = async () => {
    const response = await app.request(`${API}/oauth/instagram/start?broker=${broker.slug}`);
    const cookie = response.headers.get("set-cookie") ?? "";
    const state = new RegExp(`${cookieName}=([^;]+)`).exec(cookie)?.[1] ?? "";
    return { response, cookie, state: decodeURIComponent(state) };
  };
  const callback = (query: Record<string, string>, cookieState?: string) =>
    app.request(`${API}/oauth/instagram/callback?${new URLSearchParams(query)}`, {
      headers:
        cookieState === undefined
          ? {}
          : { Cookie: `${cookieName}=${encodeURIComponent(cookieState)}` },
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
  it("firma el state, lo deja en una cookie HttpOnly, SameSite=Lax y Path=/, y manda a Instagram", async () => {
    const { start, auth } = setup();
    const { response, cookie, state } = await start();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(auth.authorizeUrl(state));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/^agentsales_oauth_state=/);
    expect(cookie).toMatch(/Path=\/;/);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(cookie).not.toMatch(/Secure/);
    expect(createStateSigner(TEST_ENCRYPTION_KEY).verify(state)).toMatchObject({
      platform: "instagram",
      broker: "corredor-inventado",
    });
  });

  it("con la URI https la cookie es __Host-, Secure, Path=/ y sin Domain (F8-T02)", async () => {
    const { cookie, state } = await setup({ secureCookie: true }).start();
    expect(cookie).toMatch(/^__Host-agentsales_oauth_ig=/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/Path=\/;/);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(state).not.toBe("");
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
    const [account] = await platformAccounts.list(ALL_SCOPE);
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
    expect(await platformAccounts.list(ALL_SCOPE)).toEqual([]);
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
    expect(await platformAccounts.list(ALL_SCOPE)).toEqual([]);
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

  it("el state usado dos veces, aun con su cookie, no canjea de nuevo (F8-T17)", async () => {
    const { start, callback, auth, platformAccounts } = setup();
    const { state } = await start();
    expect(panelRedirect(await callback({ code: "AQB", state }, state))).toEqual({
      conectada: "instagram",
    });
    // Alguien que guardó la cookie y la URL las repite: el nonce ya está anotado como usado.
    expect(panelRedirect(await callback({ code: "AQB-otro", state }, state))).toEqual({
      error: "OAUTH_STATE_INVALID",
    });
    expect(auth.calls).toEqual(["exchange", "me"]);
    expect(await platformAccounts.list(ALL_SCOPE)).toHaveLength(1);
  });

  it("un state que no canjeó (sin código) también queda usado", async () => {
    const { start, callback, auth } = setup();
    const { state } = await start();
    expect(panelRedirect(await callback({ state }, state))).toEqual({
      error: "OAUTH_CODE_MISSING",
    });
    expect(panelRedirect(await callback({ code: "AQB", state }, state))).toEqual({
      error: "OAUTH_STATE_INVALID",
    });
    expect(auth.calls).toEqual([]);
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
    const app = adminApp(
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
    const [account] = await platformAccounts.list(ALL_SCOPE);
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
    const ghost = signer.sign(
      { platform: "instagram", broker: "ya-no-existe" },
      { ttlSeconds: 600 },
    );
    expect(panelRedirect(await callback({ code: "c", state: ghost }, ghost))).toEqual({
      error: "BROKER_NOT_FOUND",
    });
  });

  it("un state de Mercado Libre (o sin plataforma) no sirve en la vuelta de Instagram", async () => {
    const { callback, auth } = setup();
    const signer = createStateSigner(TEST_ENCRYPTION_KEY);
    const states: Record<string, string>[] = [
      { platform: "mercadolibre", broker: "corredor-inventado" },
      { broker: "corredor-inventado" },
    ];
    for (const data of states) {
      const state = signer.sign(data, { ttlSeconds: 600 });
      expect(panelRedirect(await callback({ code: "c", state }, state))).toEqual({
        error: "OAUTH_STATE_INVALID",
      });
    }
    expect(auth.calls).toEqual([]);
  });

  it("sin el par de la app, la vuelta no canjea (INSTAGRAM_NOT_CONFIGURED)", async () => {
    const { callback, auth } = setup({ oauthConfigured: false });
    const state = createStateSigner(TEST_ENCRYPTION_KEY).sign(
      { platform: "instagram", broker: "corredor-inventado" },
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
      expect(deleted).toMatch(
        secureCookie ? /^__Host-agentsales_oauth_ig=;/ : /^agentsales_oauth_state=;/,
      );
      expect(deleted).toMatch(/Path=\/;/);
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
    const app = adminApp(
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

describe("instagramStartUrlOf", () => {
  it("el inicio del OAuth va en el host y la ruta de la URI de retorno, con start (F8-T02)", () => {
    expect(instagramStartUrlOf("http://localhost:8787/api/oauth/instagram/callback")).toBe(
      "http://localhost:8787/api/oauth/instagram/start",
    );
    expect(
      instagramStartUrlOf("https://agentsales.agentpey.com/api/oauth/instagram/callback"),
    ).toBe("https://agentsales.agentpey.com/api/oauth/instagram/start");
    // Sin prefijo (una URI de antes) o con una barra final, igual.
    expect(instagramStartUrlOf("https://agentsales.test/oauth/instagram/callback/")).toBe(
      "https://agentsales.test/oauth/instagram/start",
    );
  });

  it("una URI que no termina en callback suma start a su ruta, sin consulta", () => {
    expect(instagramStartUrlOf("https://agentsales.test/api/oauth/instagram?x=1")).toBe(
      "https://agentsales.test/api/oauth/instagram/start",
    );
  });
});

// F8-T19 (spec F8 §4.3, D20): la vuelta automática de Mercado Libre, con su `state` de un solo uso y
// su cookie, sobre la API con dobles (nunca llama a Mercado Libre).
describe("GET /oauth/mercadolibre/callback", () => {
  const CODE = "TG-codigo-de-la-vuelta-8035443";

  function setupMl(options: { configured?: boolean; secureCookie?: boolean } = {}) {
    const broker = contentBrokerFixture();
    const other = { ...contentBrokerFixture(), id: randomUUID(), slug: "otro-corredor" };
    const brokers = createInMemoryBrokerRepository([broker, other]);
    const platformAccounts = createInMemoryPlatformAccountRepository({ nextId: randomUUID });
    const mercadoLibre = fakeMercadoLibreAuth();
    const instagram = fakeInstagramAuth();
    const secureCookie = options.secureCookie ?? false;
    const app = adminApp(
      testDeps({
        brokers,
        platformAccounts,
        access: { allowedHosts: ["localhost:8787"], allowedOrigins: [PANEL] },
        panelUrl: PANEL,
        instagram: { auth: instagram, oauthConfigured: true, secureCookie: false },
        mercadoLibre: {
          auth: mercadoLibre,
          configured: options.configured ?? true,
          redirectUri: TEST_ML_REDIRECT_URI,
          secureCookie,
        },
      }),
    );
    const cookieName = mercadoLibreStateCookieName(secureCookie);
    /** Pide la URL como el panel: el `state` de la URL y la cookie que puso `authorize-url`. */
    const authorize = async (slug = broker.slug) => {
      const response = await app.request(`${API}/accounts/mercadolibre/authorize-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ broker: slug }),
      });
      const { url } = (await response.json()) as { url: string };
      const state = new URL(url).searchParams.get("state") ?? "";
      const cookie = new RegExp(`${cookieName}=([^;]+)`).exec(
        response.headers.get("set-cookie") ?? "",
      )?.[1];
      return { state, cookie: cookie === undefined ? undefined : decodeURIComponent(cookie) };
    };
    const callback = (query: Record<string, string>, cookieState?: string) =>
      app.request(`${API}/oauth/mercadolibre/callback?${new URLSearchParams(query)}`, {
        headers:
          cookieState === undefined
            ? {}
            : { Cookie: `${cookieName}=${encodeURIComponent(cookieState)}` },
      });
    return {
      app,
      broker,
      other,
      platformAccounts,
      mercadoLibre,
      instagram,
      authorize,
      callback,
      cookieName,
    };
  }

  it("la vuelta buena canjea el código, guarda la cuenta de Portal cifrada y vuelve al panel", async () => {
    const t = setupMl();
    const { state, cookie } = await t.authorize();
    expect(cookie).toBe(state);

    const response = await t.callback({ code: CODE, state }, cookie);

    expect(panelRedirect(response)).toEqual({
      conectada: "mercadolibre",
      proveedor: "mercadolibre",
    });
    expect(t.mercadoLibre.calls).toEqual(["exchange", "me"]);
    const [account] = await t.platformAccounts.list(ALL_SCOPE);
    expect(account).toMatchObject({
      brokerId: t.broker.id,
      platform: "portal_inmobiliario",
      externalAccountId: "8035443",
      status: "connected",
    });
    expect(t.platformAccounts.storedCredentials(account?.id ?? "")).toMatchObject({
      accessToken: `APP_USR-fake-${CODE}`,
      refreshToken: `TG-fake-${CODE}`,
    });
    // La cookie se borra, y ni el código ni los tokens van en la URL de vuelta.
    expect(response.headers.get("set-cookie")).toContain(`${t.cookieName}=;`);
    const location = response.headers.get("location") ?? "";
    expect(location).not.toContain(CODE);
    expect(location).not.toContain("APP_USR");
  });

  it("con HTTPS la cookie es la __Host- y la vuelta también conecta", async () => {
    const t = setupMl({ secureCookie: true });
    const { state, cookie } = await t.authorize();
    expect(t.cookieName).toBe("__Host-agentsales_oauth_ml");
    const response = await t.callback({ code: CODE, state }, cookie);
    expect(panelRedirect(response)).toMatchObject({ conectada: "mercadolibre" });
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it("el state sirve una sola vez, aun con su cookie guardada", async () => {
    const t = setupMl();
    const { state, cookie } = await t.authorize();
    await t.callback({ code: CODE, state }, cookie);

    expect(panelRedirect(await t.callback({ code: `${CODE}-otro`, state }, cookie))).toEqual({
      error: "OAUTH_STATE_INVALID",
      proveedor: "mercadolibre",
    });
    expect(t.mercadoLibre.calls).toEqual(["exchange", "me"]);
    expect(await t.platformAccounts.list(ALL_SCOPE)).toHaveLength(1);
  });

  it("sin la cookie, con otra distinta, o un state ajeno, vencido o de Instagram: OAUTH_STATE_INVALID sin llamar a Mercado Libre", async () => {
    const t = setupMl();
    const { state, cookie } = await t.authorize();
    const signer = createStateSigner(TEST_ENCRYPTION_KEY);
    const expired = signer.sign(
      { platform: "mercadolibre", broker: t.broker.slug },
      { ttlSeconds: 600, now: new Date(Date.now() - 20 * 60 * 1000) },
    );
    const instagram = signer.sign(
      { platform: "instagram", broker: t.broker.slug },
      { ttlSeconds: 600 },
    );
    const foreign = createStateSigner("otra-clave-de-32-caracteres-o-mas-0000").sign(
      { platform: "mercadolibre", broker: t.broker.slug },
      { ttlSeconds: 600 },
    );
    const tries: [string, string | undefined][] = [
      [state, undefined],
      [state, `${cookie}x`],
      [expired, expired],
      [instagram, instagram],
      [foreign, foreign],
      ["no-es-un-state", "no-es-un-state"],
    ];
    for (const [query, sent] of tries) {
      expect(panelRedirect(await t.callback({ code: CODE, state: query }, sent))).toEqual({
        error: "OAUTH_STATE_INVALID",
        proveedor: "mercadolibre",
      });
    }
    expect(panelRedirect(await t.callback({ code: CODE }))).toMatchObject({
      error: "OAUTH_STATE_INVALID",
    });
    expect(t.mercadoLibre.calls).toEqual([]);
    expect(await t.platformAccounts.list(ALL_SCOPE)).toEqual([]);
  });

  it("el state de Mercado Libre no sirve en la vuelta de Instagram, ni al revés", async () => {
    const t = setupMl();
    const { state } = await t.authorize();
    // La cookie de Instagram con el `state` de Mercado Libre.
    const response = await t.app.request(
      `${API}/oauth/instagram/callback?${new URLSearchParams({ code: "AQB", state })}`,
      {
        headers: {
          Cookie: `${instagramStateCookieName(false)}=${encodeURIComponent(state)}`,
        },
      },
    );
    expect(panelRedirect(response)).toEqual({ error: "OAUTH_STATE_INVALID" });
    expect(t.instagram.calls).toEqual([]);
  });

  it("si el administrador rechaza en Mercado Libre, vuelve con OAUTH_DENIED sin canjear", async () => {
    const t = setupMl();
    const { state, cookie } = await t.authorize();
    expect(panelRedirect(await t.callback({ error: "access_denied", state }, cookie))).toEqual({
      error: "OAUTH_DENIED",
      proveedor: "mercadolibre",
    });
    expect(t.mercadoLibre.calls).toEqual([]);
  });

  it("sin código vuelve con OAUTH_CODE_MISSING; sin el par de la app, con MERCADOLIBRE_NOT_CONFIGURED", async () => {
    const t = setupMl();
    const first = await t.authorize();
    expect(panelRedirect(await t.callback({ state: first.state }, first.cookie))).toEqual({
      error: "OAUTH_CODE_MISSING",
      proveedor: "mercadolibre",
    });
    // Sin el par, `authorize-url` ya responde 503: el `state` se firma a mano.
    const none = setupMl({ configured: false });
    const state = createStateSigner(TEST_ENCRYPTION_KEY).sign(
      { platform: "mercadolibre", broker: none.broker.slug },
      { ttlSeconds: 600 },
    );
    expect(panelRedirect(await none.callback({ code: CODE, state }, state))).toEqual({
      error: "MERCADOLIBRE_NOT_CONFIGURED",
      proveedor: "mercadolibre",
    });
    expect(none.mercadoLibre.calls).toEqual([]);
  });

  it.each([
    ["malo-codigo", "ML_AUTH_INVALID"],
    ["sin-write-codigo", "ML_PERMISSION_DENIED"],
    ["argentina-codigo", "ML_SITE_MISMATCH"],
  ])(
    "un fallo al conectar (%s) vuelve con su código, sin guardar la cuenta ni el código en la URL",
    async (code, expected) => {
      const t = setupMl();
      const { state, cookie } = await t.authorize();
      const response = await t.callback({ code, state }, cookie);
      expect(panelRedirect(response)).toEqual({ error: expected, proveedor: "mercadolibre" });
      expect(response.headers.get("location") ?? "").not.toContain(code);
      expect(await t.platformAccounts.list(ALL_SCOPE)).toEqual([]);
    },
  );

  it("el corredor sale del state firmado: una query que nombra a otro no lo cambia", async () => {
    const t = setupMl();
    const { state, cookie } = await t.authorize(t.other.slug);
    await t.callback({ code: CODE, state, broker: t.broker.slug }, cookie);
    const [account] = await t.platformAccounts.list(ALL_SCOPE);
    expect(account?.brokerId).toBe(t.other.id);
  });

  it("ni el código ni los tokens del canje, ni el state, llegan al log ni a la URL de vuelta", async () => {
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
    const broker = contentBrokerFixture();
    const app = adminApp(
      testDeps({
        brokers: createInMemoryBrokerRepository([broker]),
        logger,
        access: { allowedHosts: ["localhost:8787"], allowedOrigins: [PANEL] },
        panelUrl: PANEL,
      }),
    );
    const cookieName = mercadoLibreStateCookieName(false);
    let lastState = "";
    for (const code of ["TG-codigo-secreto", "malo-codigo-secreto"]) {
      const authorize = await app.request(`${API}/accounts/mercadolibre/authorize-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ broker: broker.slug }),
      });
      const { url } = (await authorize.json()) as { url: string };
      lastState = new URL(url).searchParams.get("state") ?? "";
      const response = await app.request(
        `${API}/oauth/mercadolibre/callback?${new URLSearchParams({ code, state: lastState })}`,
        { headers: { Cookie: `${cookieName}=${encodeURIComponent(lastState)}` } },
      );
      expect(response.headers.get("location")).not.toContain("codigo-secreto");
    }
    const written = lines.join("\n");
    expect(written).not.toContain("codigo-secreto");
    expect(written).not.toContain("APP_USR-fake");
    expect(written).not.toContain("TG-fake");
    expect(written).not.toContain(lastState);
  });

  it("borra la cookie con su Path (y Secure con HTTPS: el navegador ignora un borrado de __Host- sin él)", async () => {
    for (const secureCookie of [false, true]) {
      const t = setupMl({ secureCookie });
      const { state, cookie } = await t.authorize();
      const response = await t.callback({ code: CODE, state }, cookie);
      const deletion = response.headers.get("set-cookie") ?? "";
      expect(deletion).toContain(`${t.cookieName}=;`);
      expect(deletion).toContain("Path=/");
      expect(deletion).toContain("Max-Age=0");
      expect(deletion.includes("Secure")).toBe(secureCookie);
    }
  });

  it("rechaza otro Host (403) como el resto", async () => {
    const t = setupMl();
    const response = await t.app.request("http://otro.test/oauth/mercadolibre/callback?code=x");
    expect(response.status).toBe(403);
  });
});
