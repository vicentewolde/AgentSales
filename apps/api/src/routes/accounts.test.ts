import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createLogger } from "@agentsales/config";
import { AppError, type InstagramAuth } from "@agentsales/core";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryPlatformAccountRepository,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import {
  accountListResponseSchema,
  accountRefreshResponseSchema,
  accountResponseSchema,
  errorBodySchema,
} from "../contracts/index.js";
import { fakeInstagramAuth, testDeps } from "../testing/index.js";

const TOKEN = "IGAA-token-del-panel-0123456789";
/** Un POST sin cuerpo: con `Content-Type` JSON, como la CLI (sin él, el CSRF lo trata como formulario). */
const emptyPost = { method: "POST", headers: { "Content-Type": "application/json" } };

function setup(auth: InstagramAuth = fakeInstagramAuth()) {
  const broker = contentBrokerFixture();
  const brokers = createInMemoryBrokerRepository([broker]);
  const platformAccounts = createInMemoryPlatformAccountRepository({ nextId: randomUUID });
  const app = createApp(
    testDeps({
      brokers,
      platformAccounts,
      instagram: { auth, oauthConfigured: true, secureCookie: false },
    }),
  );
  const connect = (body: Record<string, unknown>) =>
    app.request("/accounts/connect-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, broker, platformAccounts, connect };
}

describe("POST /accounts/connect-token", () => {
  it("conecta con el token del panel: la cuenta queda conectada y cifrada, y la respuesta no lleva el token", async () => {
    const { broker, platformAccounts, connect } = setup();
    const response = await connect({ broker: broker.slug, platform: "instagram", token: TOKEN });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    const { account } = accountResponseSchema.parse(JSON.parse(text));
    expect(account).toMatchObject({
      brokerId: broker.id,
      platform: "instagram",
      displayName: "@corredora",
      status: "connected",
      tokenExpiryEstimated: true,
      permissions: null,
      tokenRefreshedAt: null,
      accountType: "BUSINESS",
    });
    expect(platformAccounts.storedCredentials(account.id)).toEqual({ accessToken: TOKEN });
  });

  it("valida el cuerpo: plataforma, token con espacios o corto (REQUEST_INVALID), sin llamar a Instagram", async () => {
    const auth = fakeInstagramAuth();
    const { broker, connect } = setup(auth);
    for (const body of [
      { broker: broker.slug, platform: "portal_inmobiliario", token: TOKEN },
      { broker: broker.slug, platform: "instagram", token: "IGAA con espacios 0123456789" },
      { broker: broker.slug, platform: "instagram", token: "corto" },
      { platform: "instagram", token: TOKEN },
    ]) {
      const response = await connect(body);
      expect(response.status).toBe(400);
      const error = errorBodySchema.parse(await response.json());
      expect(error.error.code).toBe("REQUEST_INVALID");
      expect(JSON.stringify(error)).not.toContain("con espacios");
    }
    expect(auth.calls).toEqual([]);
  });

  it("un corredor que no existe es 404 BROKER_NOT_FOUND", async () => {
    const { connect } = setup();
    const response = await connect({ broker: "no-existe", platform: "instagram", token: TOKEN });
    expect(response.status).toBe(404);
    expect(errorBodySchema.parse(await response.json()).error.code).toBe("BROKER_NOT_FOUND");
  });

  it("los errores de Instagram tienen su HTTP: token rechazado 400, sin red 503, respuesta rara 502, límite 429", async () => {
    for (const [error, status] of [
      [new AppError("IG_AUTH_INVALID", "venció"), 400],
      [new AppError("IG_PERMISSION_DENIED", "sin permiso"), 400],
      [new AppError("IG_UNAVAILABLE", "Instagram no respondió", { retriable: true }), 503],
      [new AppError("IG_UNEXPECTED_RESPONSE", "Instagram respondió algo inesperado"), 502],
      [new AppError("IG_RATE_LIMITED", "límite"), 429],
    ] as const) {
      const auth: InstagramAuth = {
        ...fakeInstagramAuth(),
        me: async () => {
          throw error;
        },
      };
      const { broker, platformAccounts, connect } = setup(auth);
      const response = await connect({ broker: broker.slug, platform: "instagram", token: TOKEN });
      expect(response.status, error.code).toBe(status);
      const text = await response.text();
      expect(errorBodySchema.parse(JSON.parse(text)).error.code).toBe(error.code);
      expect(text).not.toContain(TOKEN);
      expect(await platformAccounts.list()).toEqual([]);
    }
  });
});

describe("GET /accounts y POST /accounts/:id/disconnect", () => {
  it("lista las cuentas sin credenciales y desconecta una", async () => {
    const { app, broker, platformAccounts, connect } = setup();
    const connected = accountResponseSchema.parse(
      await (await connect({ broker: broker.slug, platform: "instagram", token: TOKEN })).json(),
    ).account;

    const list = await app.request("/accounts");
    const listText = await list.text();
    expect(listText).not.toContain(TOKEN);
    expect(accountListResponseSchema.parse(JSON.parse(listText)).accounts).toMatchObject([
      { id: connected.id, status: "connected" },
    ]);

    const response = await app.request(`/accounts/${connected.id}/disconnect`, emptyPost);
    expect(response.status).toBe(200);
    expect(accountResponseSchema.parse(await response.json()).account).toMatchObject({
      status: "revoked",
    });
    expect(platformAccounts.storedCredentials(connected.id)).toBeNull();
  });

  it("desconectar una cuenta que no existe es 404; un id que no es uuid, 400", async () => {
    const { app } = setup();
    const missing = await app.request(`/accounts/${randomUUID()}/disconnect`, emptyPost);
    expect(missing.status).toBe(404);
    expect(errorBodySchema.parse(await missing.json()).error.code).toBe("ACCOUNT_NOT_FOUND");
    const invalid = await app.request("/accounts/abc/disconnect", emptyPost);
    expect(invalid.status).toBe(400);
  });

  it("las rutas de cuentas pasan el hostGuard con localhost:8787 y rechazan otro Host", async () => {
    const app = createApp(
      testDeps({ access: { allowedHosts: ["localhost:8787"], allowedOrigins: [] } }),
    );
    expect((await app.request("http://localhost:8787/accounts")).status).toBe(200);
    expect((await app.request("http://evil.test:8787/accounts")).status).toBe(403);
  });
});

describe("cuentas · seguridad y mensajes", () => {
  it("los mensajes del token dicen qué hacer, y la causa de un cuerpo inválido", async () => {
    const auth: InstagramAuth = {
      ...fakeInstagramAuth(),
      me: async () => {
        throw new AppError("IG_AUTH_INVALID", "El acceso venció: reconecta la cuenta", {
          details: { token: TOKEN },
          cause: new Error(TOKEN),
        });
      },
    };
    const { broker, connect } = setup(auth);
    const rejected = await connect({ broker: broker.slug, platform: "instagram", token: TOKEN });
    const text = await rejected.text();
    expect(text).not.toContain(TOKEN);
    expect(errorBodySchema.parse(JSON.parse(text)).error.message).toContain("Generate token");

    const spaced = await connect({
      broker: broker.slug,
      platform: "instagram",
      token: "IGAA con espacios 0123456789",
    });
    expect(errorBodySchema.parse(await spaced.json()).error.message).toContain("espacios");
  });

  it("ni el token ni sus detalles llegan al log, también cuando Instagram falla", async () => {
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
    const auth: InstagramAuth = {
      ...fakeInstagramAuth(),
      me: async () => {
        throw new AppError("IG_UNEXPECTED_RESPONSE", "rara", { details: { call: "me" } });
      },
    };
    const app = createApp(
      testDeps({
        logger,
        brokers: createInMemoryBrokerRepository([broker]),
        instagram: { auth, oauthConfigured: true, secureCookie: false },
      }),
    );
    for (const token of [TOKEN, "IGAA con espacios 0123456789"]) {
      await app.request("/accounts/connect-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ broker: broker.slug, platform: "instagram", token }),
      });
    }
    const written = lines.join("\n");
    expect(written).not.toContain(TOKEN);
    expect(written).not.toContain("con espacios");
  });

  it("conectar una segunda cuenta por HTTP deja la primera desconectada", async () => {
    const auth: InstagramAuth = {
      ...fakeInstagramAuth(),
      me: async (accessToken) => ({
        userId: accessToken.endsWith("A") ? "17841400000000001" : "17841400000000002",
        username: accessToken.endsWith("A") ? "primera" : "segunda",
        accountType: "BUSINESS",
      }),
    };
    const { app, broker, connect } = setup(auth);
    await connect({ broker: broker.slug, platform: "instagram", token: `${TOKEN}A` });
    await connect({ broker: broker.slug, platform: "instagram", token: `${TOKEN}B` });
    const { accounts } = accountListResponseSchema.parse(
      await (await app.request("/accounts")).json(),
    );
    expect(accounts.map((account) => [account.displayName, account.status])).toEqual([
      ["@primera", "revoked"],
      ["@segunda", "connected"],
    ]);
  });

  it("GET /accounts dice si el panel puede ofrecer el OAuth (par de la app y https)", async () => {
    for (const [oauthConfigured, secureCookie, oauth] of [
      [true, true, true],
      [true, false, false],
      [false, true, false],
    ] as const) {
      const app = createApp(
        testDeps({ instagram: { auth: fakeInstagramAuth(), oauthConfigured, secureCookie } }),
      );
      const body = accountListResponseSchema.parse(await (await app.request("/accounts")).json());
      expect(body.connect.instagram.oauth).toBe(oauth);
    }
  });

  it("desconectar dos veces deja la cuenta igual; sin JSON y desde otro origen, el CSRF la protege", async () => {
    const { app, broker, platformAccounts, connect } = setup();
    const { account } = accountResponseSchema.parse(
      await (await connect({ broker: broker.slug, platform: "instagram", token: TOKEN })).json(),
    );
    const blocked = await app.request(`/accounts/${account.id}/disconnect`, {
      method: "POST",
      headers: { Origin: "http://evil.test" },
    });
    expect(blocked.status).toBe(403);
    expect((await platformAccounts.get(account.id))?.status).toBe("connected");

    for (let i = 0; i < 2; i += 1) {
      const response = await app.request(`/accounts/${account.id}/disconnect`, emptyPost);
      expect(response.status).toBe(200);
      expect(accountResponseSchema.parse(await response.json()).account.status).toBe("revoked");
    }
  });
});

describe("POST /accounts/:id/refresh", () => {
  const CONNECTED_AT = new Date("2026-10-06T12:00:00Z");
  const HOUR = 60 * 60 * 1000;

  /** La API con un reloj que avanza a mano (`AppDeps.now`) y una cuenta conectada con el token. */
  async function refreshSetup(options: { logger?: ReturnType<typeof createLogger> } = {}) {
    const broker = contentBrokerFixture();
    const auth = fakeInstagramAuth();
    const platformAccounts = createInMemoryPlatformAccountRepository({ nextId: randomUUID });
    let clock = CONNECTED_AT;
    const app = createApp(
      testDeps({
        brokers: createInMemoryBrokerRepository([broker]),
        platformAccounts,
        instagram: { auth, oauthConfigured: true, secureCookie: false },
        now: () => clock,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      }),
    );
    const connect = async (token: string) => {
      const response = await app.request("/accounts/connect-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ broker: broker.slug, platform: "instagram", token }),
      });
      return accountResponseSchema.parse(await response.json()).account;
    };
    const refresh = (id: string, body: unknown = {}) =>
      app.request(`/accounts/${id}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const advance = (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    };
    const refreshCalls = () => auth.calls.filter((call) => call === "refresh").length;
    return { app, auth, platformAccounts, connect, refresh, advance, refreshCalls };
  }

  it("recién conectada con el token del panel: ni con force se refresca antes de 24 h", async () => {
    const { connect, refresh, refreshCalls } = await refreshSetup();
    const account = await connect(TOKEN);

    const response = await refresh(account.id, { force: true });

    expect(response.status).toBe(200);
    expect(accountRefreshResponseSchema.parse(await response.json())).toMatchObject({
      outcome: "skipped",
      reason: "too_recent",
      refreshableAt: new Date(CONNECTED_AT.getTime() + 24 * HOUR),
      account: { status: "connected", tokenExpiryEstimated: true },
    });
    expect(refreshCalls()).toBe(0);
  });

  it("pasadas 24 h: sin force no toca (le quedan 59 días); con force refresca y guarda el vencimiento real", async () => {
    const { platformAccounts, connect, refresh, advance, refreshCalls } = await refreshSetup();
    const account = await connect(TOKEN);
    advance(25 * HOUR);

    const notDue = accountRefreshResponseSchema.parse(await (await refresh(account.id)).json());
    expect(notDue).toMatchObject({ outcome: "skipped", reason: "not_due" });
    expect(notDue.refreshableAt).toEqual(new Date("2026-11-05T12:00:00Z"));
    expect(refreshCalls()).toBe(0);

    const response = await refresh(account.id, { force: true });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    expect(accountRefreshResponseSchema.parse(JSON.parse(text))).toMatchObject({
      outcome: "refreshed",
      reason: null,
      refreshableAt: null,
      account: {
        status: "connected",
        tokenExpiresAt: new Date("2026-12-05T12:00:00Z"),
        tokenExpiryEstimated: false,
        tokenRefreshedAt: new Date(CONNECTED_AT.getTime() + 25 * HOUR),
        permissions: null,
      },
    });
    expect(platformAccounts.storedCredentials(account.id)).toEqual({
      accessToken: `${TOKEN}-refrescado`,
    });
  });

  it("Instagram rechaza el token (190): 200 con la cuenta vencida", async () => {
    const { platformAccounts, connect, refresh, advance } = await refreshSetup();
    const account = await connect(TOKEN);
    // El token guardado deja de servir después de conectar (por ejemplo, se cambió la contraseña).
    await platformAccounts.upsertConnected({
      brokerId: account.brokerId,
      platform: "instagram",
      externalAccountId: "17841400000000001",
      displayName: account.displayName,
      tokenExpiresAt: account.tokenExpiresAt,
      meta: (await platformAccounts.get(account.id))?.meta ?? {},
      credentials: { accessToken: "malo-token-0123456789" },
    });
    advance(25 * HOUR);

    const response = await refresh(account.id, { force: true });

    expect(response.status).toBe(200);
    expect(accountRefreshResponseSchema.parse(await response.json())).toMatchObject({
      outcome: "expired",
      reason: "token_rejected",
      account: { status: "expired" },
    });
  });

  it("sin red con Instagram es 503 y la cuenta no cambia", async () => {
    const { platformAccounts, connect, refresh, advance } = await refreshSetup();
    const account = await connect(`caido-${TOKEN}`);
    advance(25 * HOUR);

    const response = await refresh(account.id, { force: true });

    expect(response.status).toBe(503);
    expect(errorBodySchema.parse(await response.json()).error.code).toBe("IG_UNAVAILABLE");
    expect(await platformAccounts.get(account.id)).toMatchObject({
      status: "connected",
      tokenExpiresAt: account.tokenExpiresAt,
    });
    expect(platformAccounts.storedCredentials(account.id)).toEqual({
      accessToken: `caido-${TOKEN}`,
    });
  });

  it("desconectada 409, inexistente 404, id que no es uuid o force que no es booleano 400", async () => {
    const { app, connect, refresh, refreshCalls } = await refreshSetup();
    const account = await connect(TOKEN);
    await app.request(`/accounts/${account.id}/disconnect`, emptyPost);

    const cases: [Response, number, string][] = [
      [await refresh(account.id, { force: true }), 409, "ACCOUNT_NOT_CONNECTED"],
      [await refresh(randomUUID()), 404, "ACCOUNT_NOT_FOUND"],
      [await refresh("no-es-uuid"), 400, "REQUEST_INVALID"],
      [await refresh(account.id, { force: "si" }), 400, "REQUEST_INVALID"],
    ];
    for (const [response, status, code] of cases) {
      expect(response.status).toBe(status);
      expect(errorBodySchema.parse(await response.json()).error.code).toBe(code);
    }
    expect(refreshCalls()).toBe(0);
  });

  it("un formulario desde otro origen lo bloquea el CSRF, sin llamar a Instagram", async () => {
    const { app, connect, advance, refreshCalls } = await refreshSetup();
    const account = await connect(TOKEN);
    advance(25 * HOUR);

    // Lo que puede mandar otra página sin preflight: un cuerpo de texto, no JSON.
    const response = await app.request(`/accounts/${account.id}/refresh`, {
      method: "POST",
      headers: { Origin: "http://evil.test" },
      body: JSON.stringify({ force: true }),
    });

    expect(response.status).toBe(403);
    expect(refreshCalls()).toBe(0);
  });

  it("ni el token viejo ni el nuevo llegan al log", async () => {
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
    const ok = await refreshSetup({ logger });
    const account = await ok.connect(TOKEN);
    ok.advance(25 * HOUR);
    expect((await ok.refresh(account.id, { force: true })).status).toBe(200);
    const down = await refreshSetup({ logger });
    const unreachable = await down.connect(`caido-${TOKEN}`);
    down.advance(25 * HOUR);
    expect((await down.refresh(unreachable.id, { force: true })).status).toBe(503);

    const written = lines.join("\n");
    expect(written).not.toContain(TOKEN);
  });
});
