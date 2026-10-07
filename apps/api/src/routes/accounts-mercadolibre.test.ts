import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createLogger, createStateSigner } from "@agentsales/config";
import { AppError } from "@agentsales/core";
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
  mercadoLibreAuthorizeUrlResponseSchema,
} from "../contracts/index.js";
import {
  fakeMercadoLibreAuth,
  TEST_ENCRYPTION_KEY,
  TEST_ML_REDIRECT_URI,
  testDeps,
} from "../testing/index.js";

const CODE = "TG-codigo-pegado-8035443";
const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function setup(options: { configured?: boolean; logLines?: string[]; now?: () => Date } = {}) {
  const broker = contentBrokerFixture();
  const otherBroker = { ...contentBrokerFixture(), id: randomUUID(), slug: "otro-corredor" };
  const brokers = createInMemoryBrokerRepository([broker, otherBroker]);
  const platformAccounts = createInMemoryPlatformAccountRepository({ nextId: randomUUID });
  const auth = fakeMercadoLibreAuth();
  const lines = options.logLines;
  const logger =
    lines === undefined
      ? undefined
      : createLogger(
          { level: "debug" },
          new Writable({
            write(chunk, _encoding, callback) {
              lines.push(chunk.toString());
              callback();
            },
          }),
        );
  const app = createApp(
    testDeps({
      brokers,
      platformAccounts,
      ...(logger === undefined ? {} : { logger }),
      ...(options.now === undefined ? {} : { now: options.now }),
      mercadoLibre: {
        auth,
        configured: options.configured ?? true,
        redirectUri: TEST_ML_REDIRECT_URI,
      },
    }),
  );
  const authorize = (brokerSlug = broker.slug) =>
    app.request("/accounts/mercadolibre/authorize-url", json({ broker: brokerSlug }));
  /** Pide la URL y devuelve el `state` que trae, como haría la CLI. */
  const freshState = async (brokerSlug = broker.slug) => {
    const body = mercadoLibreAuthorizeUrlResponseSchema.parse(
      await (await authorize(brokerSlug)).json(),
    );
    return new URL(body.url).searchParams.get("state") ?? "";
  };
  const connect = (body: Record<string, unknown>) =>
    app.request("/accounts/mercadolibre/connect", json(body));
  return { app, broker, otherBroker, platformAccounts, auth, authorize, freshState, connect };
}

describe("GET /accounts con Mercado Libre", () => {
  it("dice si Mercado Libre está configurado y la dirección de retorno", async () => {
    for (const configured of [true, false]) {
      const { app } = setup({ configured });
      const body = accountListResponseSchema.parse(await (await app.request("/accounts")).json());
      expect(body.connect.mercadolibre).toEqual({ configured, redirectUri: TEST_ML_REDIRECT_URI });
    }
  });
});

describe("POST /accounts/mercadolibre/authorize-url", () => {
  it("la URL de autorización con un state firmado de 10 min, con la plataforma y el corredor", async () => {
    const { authorize, broker, auth } = setup();

    const response = await authorize();

    expect(response.status).toBe(200);
    const { url } = mercadoLibreAuthorizeUrlResponseSchema.parse(await response.json());
    expect(url).toMatch(/^https:\/\/auth\.mercadolibre\.cl\/authorization\?/);
    const state = new URL(url).searchParams.get("state") ?? "";
    const data = createStateSigner(TEST_ENCRYPTION_KEY).verify(state);
    expect(data).toMatchObject({ platform: "mercadolibre", broker: broker.slug });
    expect(Number(data.exp) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600);
    expect(auth.calls).toEqual([]);
  });

  it("sin el par de la app: 503 MERCADOLIBRE_NOT_CONFIGURED con el paso a seguir", async () => {
    const { authorize, auth } = setup({ configured: false });

    const response = await authorize();

    expect(response.status).toBe(503);
    const { error } = errorBodySchema.parse(await response.json());
    expect(error.code).toBe("MERCADOLIBRE_NOT_CONFIGURED");
    expect(error.message).toContain("ML_APP_ID");
    expect(auth.calls).toEqual([]);
  });

  it("un corredor que no existe es 404", async () => {
    const { authorize } = setup();

    const response = await authorize("no-existe");

    expect(response.status).toBe(404);
    expect(errorBodySchema.parse(await response.json()).error.code).toBe("BROKER_NOT_FOUND");
  });
});

describe("POST /accounts/mercadolibre/connect", () => {
  it("conecta: la cuenta de Portal queda conectada con el par cifrado, y la respuesta no lleva el código ni los tokens", async () => {
    const { connect, freshState, broker, platformAccounts, auth } = setup();
    const state = await freshState();

    const response = await connect({ broker: broker.slug, code: CODE, state });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(CODE);
    expect(text).not.toMatch(/APP_USR|TG-/);
    const { account } = accountResponseSchema.parse(JSON.parse(text));
    expect(account).toMatchObject({
      brokerId: broker.id,
      platform: "portal_inmobiliario",
      displayName: "CORREDORA_PRUEBA",
      status: "connected",
      tokenExpiryEstimated: true,
      accountType: "normal",
      permissions: ["offline_access", "read", "write"],
      tokenRefreshedAt: null,
    });
    expect(account.connectedAt).toBeInstanceOf(Date);
    await expect(platformAccounts.getCredentials(account.id)).resolves.toEqual({
      accessToken: `APP_USR-fake-${CODE}`,
      refreshToken: `TG-fake-${CODE}`,
    });
    expect(auth.calls).toEqual(["exchange", "me"]);
  });

  it("un state vencido, alterado, de otra clave, de Instagram o de otro corredor: 400 OAUTH_STATE_INVALID sin llamar", async () => {
    const { connect, freshState, broker, otherBroker, auth } = setup();
    const signer = createStateSigner(TEST_ENCRYPTION_KEY);
    const valid = await freshState();
    const expired = signer.sign(
      { platform: "mercadolibre", broker: broker.slug },
      { ttlSeconds: 600, now: new Date(Date.now() - 20 * 60 * 1000) },
    );
    const forged = createStateSigner("otra-clave-de-32-caracteres-o-mas-0123456789").sign(
      { platform: "mercadolibre", broker: broker.slug },
      { ttlSeconds: 600 },
    );
    const instagram = signer.sign(
      { platform: "instagram", broker: broker.slug },
      { ttlSeconds: 600 },
    );
    const withoutPlatform = signer.sign({ broker: broker.slug }, { ttlSeconds: 600 });
    const otherBrokers = await freshState(otherBroker.slug);
    const altered = `${valid.slice(0, -2)}${valid.endsWith("AA") ? "BB" : "AA"}`;

    for (const state of [
      expired,
      forged,
      instagram,
      withoutPlatform,
      otherBrokers,
      altered,
      "x.y",
    ]) {
      const response = await connect({ broker: broker.slug, code: CODE, state });
      expect(response.status).toBe(400);
      expect(errorBodySchema.parse(await response.json()).error.code).toBe("OAUTH_STATE_INVALID");
    }
    expect(auth.calls).toEqual([]);
  });

  it("sin el par de la app: 503 MERCADOLIBRE_NOT_CONFIGURED sin llamar", async () => {
    const { connect, broker, auth } = setup({ configured: false });
    const state = createStateSigner(TEST_ENCRYPTION_KEY).sign(
      { platform: "mercadolibre", broker: broker.slug },
      { ttlSeconds: 600 },
    );

    const response = await connect({ broker: broker.slug, code: CODE, state });

    expect(response.status).toBe(503);
    expect(errorBodySchema.parse(await response.json()).error.code).toBe(
      "MERCADOLIBRE_NOT_CONFIGURED",
    );
    expect(auth.calls).toEqual([]);
  });

  it.each([
    ["malo-vencido", 400, "ML_AUTH_INVALID"],
    ["rechazado", 400, "ML_REQUEST_REJECTED"],
    ["sin-offline", 400, "ML_PERMISSION_DENIED"],
    ["sin-write", 400, "ML_PERMISSION_DENIED"],
    ["sin-refresh", 502, "ML_UNEXPECTED_RESPONSE"],
    ["otro-usuario", 502, "ML_UNEXPECTED_RESPONSE"],
    ["argentina", 400, "ML_SITE_MISMATCH"],
  ] as const)(
    "el código %s responde %i %s, sin el código ni los tokens",
    async (prefix, status, code) => {
      const { connect, freshState, broker, platformAccounts } = setup();
      const pasted = `${prefix}-TG-8035443`;

      const response = await connect({
        broker: broker.slug,
        code: pasted,
        state: await freshState(),
      });

      expect(response.status).toBe(status);
      const text = await response.text();
      expect(errorBodySchema.parse(JSON.parse(text)).error.code).toBe(code);
      expect(text).not.toContain(pasted);
      expect(text).not.toMatch(/APP_USR|TG-fake/);
      await expect(platformAccounts.list()).resolves.toEqual([]);
    },
  );

  it("al conectar, los mensajes dicen qué hacer con la dirección pegada", async () => {
    const { connect, freshState, broker } = setup();

    const expired = await connect({
      broker: broker.slug,
      code: "malo-TG",
      state: await freshState(),
    });
    const rejected = await connect({
      broker: broker.slug,
      code: "rechazado-TG",
      state: await freshState(),
    });

    expect(errorBodySchema.parse(await expired.json()).error.message).toContain(
      "pide el enlace de nuevo",
    );
    expect(errorBodySchema.parse(await rejected.json()).error.message).toContain("ML_REDIRECT_URI");
  });

  it("otra cuenta de Mercado Libre del corredor desconecta la anterior", async () => {
    const { connect, freshState, broker, platformAccounts } = setup();

    const first = accountResponseSchema.parse(
      await (await connect({ broker: broker.slug, code: CODE, state: await freshState() })).json(),
    );
    const second = accountResponseSchema.parse(
      await (
        await connect({ broker: broker.slug, code: "otra-cuenta-TG", state: await freshState() })
      ).json(),
    );

    expect(second.account).toMatchObject({ displayName: "OTRA_CUENTA", status: "connected" });
    const accounts = await platformAccounts.list();
    expect(accounts.find((account) => account.id === first.account.id)?.status).toBe("revoked");
    expect(accounts.filter((account) => account.status === "connected")).toHaveLength(1);
  });

  it("un código o un state con espacios es 400 con el motivo, sin llamar", async () => {
    const { connect, freshState, broker, auth } = setup();
    const state = await freshState();

    const spaced = await connect({ broker: broker.slug, code: "TG-con espacio", state });
    const missing = await connect({ broker: broker.slug, state });

    expect(spaced.status).toBe(400);
    expect(errorBodySchema.parse(await spaced.json()).error.message).toContain("espacios");
    expect(missing.status).toBe(400);
    expect(auth.calls).toEqual([]);
  });

  it("reconectar actualiza la misma cuenta; una sola conectada por corredor", async () => {
    const { connect, freshState, broker, platformAccounts } = setup();

    const first = accountResponseSchema.parse(
      await (await connect({ broker: broker.slug, code: CODE, state: await freshState() })).json(),
    );
    const again = accountResponseSchema.parse(
      await (
        await connect({ broker: broker.slug, code: `${CODE}-2`, state: await freshState() })
      ).json(),
    );

    expect(again.account.id).toBe(first.account.id);
    const accounts = await platformAccounts.list();
    expect(accounts.filter((account) => account.status === "connected")).toHaveLength(1);
    await expect(platformAccounts.getCredentials(first.account.id)).resolves.toMatchObject({
      accessToken: `APP_USR-fake-${CODE}-2`,
    });
  });

  it("ni el código, ni el state, ni los tokens llegan al log, también cuando falla", async () => {
    const lines: string[] = [];
    const { connect, freshState, broker } = setup({ logLines: lines });
    const states: string[] = [];

    for (const code of [CODE, "malo-TG-8035443", "sin-refresh-TG-8035443", "TG con espacio"]) {
      const state = await freshState();
      states.push(state);
      await connect({ broker: broker.slug, code, state });
    }

    const written = lines.join("\n");
    expect(written.length).toBeGreaterThan(0);
    for (const secret of [CODE, "malo-TG", "sin-refresh-TG", "con espacio", ...states]) {
      expect(written).not.toContain(secret);
    }
    expect(written).not.toMatch(/APP_USR|TG-fake/);
  });
});

describe("POST /accounts/:id/refresh con Mercado Libre", () => {
  const CONNECTED_AT = new Date("2026-10-07T12:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;

  /** La API con un reloj que avanza a mano y una cuenta conectada con el código pedido. */
  async function refreshSetup(options: { configured?: boolean; logLines?: string[] } = {}) {
    let clock = CONNECTED_AT;
    const base = setup({ ...options, now: () => clock });
    const connectWith = async (code: string) => {
      const state = await base.freshState();
      const response = await base.connect({ broker: base.broker.slug, code, state });
      return accountResponseSchema.parse(await response.json()).account;
    };
    const refresh = (id: string, body: unknown = {}) =>
      base.app.request(`/accounts/${id}/refresh`, json(body));
    const advance = (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    };
    const refreshCalls = () => base.auth.calls.filter((call) => call === "refresh").length;
    return { ...base, connectWith, refresh, advance, refreshCalls };
  }

  it("recién conectada no toca (not_due, a los 7 días); con force se refresca y guarda el par completo", async () => {
    const { connectWith, refresh, platformAccounts, refreshCalls } = await refreshSetup();
    const account = await connectWith("codigo-ok");

    const skipped = await refresh(account.id);
    expect(skipped.status).toBe(200);
    expect(accountRefreshResponseSchema.parse(await skipped.json())).toMatchObject({
      outcome: "skipped",
      reason: "not_due",
      refreshableAt: new Date(CONNECTED_AT.getTime() + 7 * DAY),
    });
    expect(refreshCalls()).toBe(0);

    const forced = await refresh(account.id, { force: true });
    expect(forced.status).toBe(200);
    const text = await forced.text();
    expect(text).not.toMatch(/APP_USR|TG-/);
    expect(accountRefreshResponseSchema.parse(JSON.parse(text))).toMatchObject({
      outcome: "refreshed",
      account: {
        id: account.id,
        platform: "portal_inmobiliario",
        status: "connected",
        tokenExpiresAt: new Date(CONNECTED_AT.getTime() + 180 * DAY),
        tokenRefreshedAt: CONNECTED_AT,
      },
    });
    expect(platformAccounts.storedCredentials(account.id)).toEqual({
      accessToken: "APP_USR-fake-refrescado-1",
      refreshToken: "TG-fake-refrescado-1",
    });
    expect(refreshCalls()).toBe(1);
  });

  it("sin force, a los 7 días del último refresco sí toca", async () => {
    const { connectWith, refresh, advance, refreshCalls } = await refreshSetup();
    const account = await connectWith("codigo-ok");
    advance(7 * DAY);

    const response = await refresh(account.id);

    expect(accountRefreshResponseSchema.parse(await response.json()).outcome).toBe("refreshed");
    expect(refreshCalls()).toBe(1);
  });

  it("un rechazo de Mercado Libre es 200 expired (token_rejected) y la cuenta queda vencida", async () => {
    const { connectWith, refresh } = await refreshSetup();
    const account = await connectWith("vence-codigo");

    const response = await refresh(account.id, { force: true });

    expect(response.status).toBe(200);
    expect(accountRefreshResponseSchema.parse(await response.json())).toMatchObject({
      outcome: "expired",
      reason: "token_rejected",
      account: { id: account.id, status: "expired" },
    });
    const again = await refresh(account.id, { force: true });
    expect(again.status).toBe(409);
    expect(errorBodySchema.parse(await again.json()).error.code).toBe("ACCOUNT_NOT_CONNECTED");
  });

  it("si Mercado Libre no responde: 503 ML_UNAVAILABLE y la cuenta no cambia", async () => {
    const { connectWith, refresh, platformAccounts } = await refreshSetup();
    const account = await connectWith("caida-codigo");

    const response = await refresh(account.id, { force: true });

    expect(response.status).toBe(503);
    expect(errorBodySchema.parse(await response.json()).error.code).toBe("ML_UNAVAILABLE");
    expect(await platformAccounts.get(account.id)).toMatchObject({ status: "connected" });
    expect(platformAccounts.storedCredentials(account.id)?.refreshToken).toBe(
      "TG-fake-caida-codigo",
    );
  });

  it("sin el par de la app: 503 MERCADOLIBRE_NOT_CONFIGURED sin llamar ni cambiar la cuenta", async () => {
    const { refresh, platformAccounts, broker, refreshCalls } = await refreshSetup({
      configured: false,
    });
    const account = await platformAccounts.upsertConnected({
      brokerId: broker.id,
      platform: "portal_inmobiliario",
      externalAccountId: "8035443",
      displayName: "CORREDORA_PRUEBA",
      tokenExpiresAt: new Date(CONNECTED_AT.getTime() + 180 * DAY),
      meta: {
        userId: "8035443",
        nickname: "CORREDORA_PRUEBA",
        siteId: "MLC",
        userType: "normal",
        scopes: ["offline_access", "read", "write"],
        testUser: false,
        connectedAt: CONNECTED_AT.toISOString(),
        tokenRefreshedAt: null,
        accessTokenExpiresAt: CONNECTED_AT.toISOString(),
        tokenExpiryEstimated: true,
      },
      credentials: { accessToken: "APP_USR-guardado", refreshToken: "TG-guardado" },
    });

    const response = await refresh(account.id, { force: true });

    expect(response.status).toBe(503);
    const { error } = errorBodySchema.parse(await response.json());
    expect(error.code).toBe("MERCADOLIBRE_NOT_CONFIGURED");
    expect(error.message).toContain("ML_APP_ID");
    expect(refreshCalls()).toBe(0);
    expect(platformAccounts.storedCredentials(account.id)).toEqual({
      accessToken: "APP_USR-guardado",
      refreshToken: "TG-guardado",
    });
  });

  it("si otro proceso la está renovando: 503 ACCOUNT_LOCK_TIMEOUT, que se reintenta en un momento", async () => {
    const { connectWith, refresh, platformAccounts, refreshCalls } = await refreshSetup();
    const account = await connectWith("codigo-ok");
    platformAccounts.withCredentialsLock = async () => {
      throw new AppError(
        "ACCOUNT_LOCK_TIMEOUT",
        "Otro proceso está renovando el acceso de la cuenta: se reintenta en un momento",
        { retriable: true },
      );
    };

    const response = await refresh(account.id, { force: true });

    expect(response.status).toBe(503);
    const { error } = errorBodySchema.parse(await response.json());
    expect(error).toEqual({
      code: "ACCOUNT_LOCK_TIMEOUT",
      message: "Otro proceso está renovando el acceso de la cuenta: se reintenta en un momento",
    });
    expect(refreshCalls()).toBe(0);
  });

  it("ningún token llega al log, tampoco cuando el refresco falla", async () => {
    const lines: string[] = [];
    const { connectWith, refresh } = await refreshSetup({ logLines: lines });
    for (const code of ["codigo-ok", "vence-codigo", "caida-codigo"]) {
      const account = await connectWith(code);
      await refresh(account.id, { force: true });
    }

    const written = lines.join("\n");
    expect(written.length).toBeGreaterThan(0);
    expect(written).not.toMatch(/APP_USR|TG-fake/);
  });
});
