import { randomUUID } from "node:crypto";
import {
  fakeInstagramAuth,
  fakeLinkedInAuth,
  fakeMercadoLibreAuth,
  fakeXAuth,
  TEST_ML_REDIRECT_URI,
} from "@agentsales/api/testing";
import { ALL_SCOPE } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { brokerData, harness } from "../../test/harness.js";
import {
  type AccountsDeps,
  type ConnectOptions,
  runAccounts,
  runConnect,
  runMode,
  runRefresh,
  runSpendLimit,
} from "./accounts.js";

const TOKEN = "IGAA-token-del-panel-0123456789-secreto";
const HOUR = 60 * 60 * 1000;

/** El arnés con un reloj que avanza a mano (`AppDeps.now`) y el corredor `marca`. */
async function setup(options: { oauth?: boolean } = {}) {
  let clock = new Date("2026-10-06T12:00:00Z");
  const opened: string[] = [];
  const h = harness({
    deps: {
      now: () => clock,
      instagram: {
        auth: fakeInstagramAuth(),
        oauthConfigured: true,
        secureCookie: options.oauth ?? false,
      },
      // Distinto del que escribiría alguien a mano: el enlace tiene que venir de la API.
      instagramStartUrl: "https://agentsales.test/oauth/instagram/start",
    },
  });
  await h.brokers.create(brokerData("marca"));
  const deps = (stdin: string | null = TOKEN): AccountsDeps => ({
    ...h.io,
    client: h.client,
    stdinIsTty: () => stdin === null,
    readStdin: async () => stdin ?? "",
    openUrl: (url) => opened.push(url),
    now: () => clock,
    confirm: async () => false,
    sleep: async () => {},
    clock: () => 0,
  });
  const connect = (options: ConnectOptions = { broker: "marca", tokenStdin: true }) =>
    runConnect(deps(), "instagram", options);
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  return { h, deps, connect, advance, opened };
}

describe("accounts connect", () => {
  it("conecta con el token de la entrada estándar sin mostrarlo ni mandarlo en la URL", async () => {
    const { h, connect } = await setup();

    expect(await connect()).toBe(0);
    expect(h.text()).toContain("✓ Conectada @corredora (marca)");
    expect(h.text()).toContain("(estimado: se conoce el real al renovarlo, desde mañana)");
    const [account] = await h.platformAccounts.list(ALL_SCOPE);
    expect(h.platformAccounts.storedCredentials(account?.id ?? "")).toEqual({ accessToken: TOKEN });
    expect(`${h.text()}\n${h.errors()}\n${h.requests.join("\n")}`).not.toContain(TOKEN);
    expect(h.requests).toContain("POST /accounts/connect-token");
  });

  it("en una terminal (sin tubería) no lee el token: pide pasarlo por la entrada estándar", async () => {
    const { h, deps } = await setup();

    const code = await runConnect(deps(null), "instagram", { broker: "marca", tokenStdin: true });

    expect(code).toBe(1);
    expect(h.errors()).toContain("TOKEN_STDIN_REQUIRED");
    expect(h.errors()).toContain(
      "pbpaste | pnpm -s cli accounts connect instagram --broker marca --token-stdin",
    );
    expect(h.requests).toEqual([]);
  });

  it("una entrada vacía, sin --broker u otro canal se rechazan sin llamar a la API", async () => {
    const { h, deps } = await setup();
    const cases: [Promise<number>, string][] = [
      [
        runConnect(deps("  \n"), "instagram", { broker: "marca", tokenStdin: true }),
        "TOKEN_MISSING",
      ],
      [runConnect(deps(), "instagram", { tokenStdin: true }), "BROKER_REQUIRED"],
      [runConnect(deps(), "portal", { broker: "marca", tokenStdin: true }), "PLATFORM_INVALID"],
    ];
    for (const [result, code] of cases) {
      expect(await result).toBe(1);
      expect(h.errors()).toContain(code);
    }
    expect(h.requests).toEqual([]);
  });

  it("un pegado con espacios o demasiado largo no se manda ni se muestra (TOKEN_INVALID)", async () => {
    const { h, deps } = await setup();
    for (const pasted of [`${TOKEN}\notra-linea`, `${TOKEN} ${TOKEN}`, "x".repeat(5000)]) {
      const code = await runConnect(deps(pasted), "instagram", {
        broker: "marca",
        tokenStdin: true,
      });
      expect(code).toBe(1);
    }
    expect(h.errors()).toContain("TOKEN_INVALID");
    expect(h.errors()).not.toContain(TOKEN);
    expect(h.requests).toEqual([]);
  });

  it("un token que Instagram rechaza muestra el mensaje de la API, sin el token", async () => {
    const { h, deps } = await setup();

    const code = await runConnect(deps(`malo-${TOKEN}`), "instagram", {
      broker: "marca",
      tokenStdin: true,
    });

    expect(code).toBe(1);
    expect(h.errors()).toContain("IG_AUTH_INVALID");
    expect(h.errors()).toContain("Generate token");
    expect(h.errors()).not.toContain(TOKEN);
  });

  it("sin --token-stdin y sin OAuth disponible (http://localhost) explica el camino del token", async () => {
    const { h, opened, connect } = await setup();

    expect(await connect({ broker: "marca" })).toBe(1);
    expect(h.errors()).toContain("OAUTH_UNAVAILABLE");
    expect(h.errors()).toContain("--token-stdin");
    expect(opened).toEqual([]);
  });

  it("sin --token-stdin y con OAuth disponible (https, F7) imprime y abre el enlace", async () => {
    const { h, opened, connect } = await setup({ oauth: true });

    expect(await connect({ broker: "Marca" })).toBe(0);
    expect(opened).toEqual(["https://agentsales.test/oauth/instagram/start?broker=marca"]);
    expect(h.text()).toContain(opened[0]);
  });
});

describe("accounts y accounts refresh", () => {
  it("lista las cuentas con su corredor, estado y vencimiento estimado", async () => {
    const { h, deps, connect } = await setup();
    await connect();

    expect(await runAccounts(deps())).toBe(0);
    const text = h.text();
    expect(text).toContain("CORREDOR");
    expect(text).toMatch(
      /marca\s+Instagram\s+@corredora\s+conectada\s+2026-12-0\d \d\d:\d\d \(estimado\)/,
    );
  });

  it("sin cuentas dice cómo conectar una", async () => {
    const { h, deps } = await setup();

    expect(await runAccounts(deps())).toBe(0);
    expect(h.text()).toContain("No hay cuentas conectadas");
  });

  it("refresh: un token que no vence dice que no se renueva (F9-T02)", async () => {
    const { h, deps } = await setup();
    const broker = await h.brokers.findBySlug("marca");
    const account = await h.platformAccounts.upsertConnected({
      brokerId: broker?.id ?? "",
      platform: "instagram",
      externalAccountId: "17841400000000099",
      displayName: "@system-user",
      tokenExpiresAt: null,
      meta: { accountType: "BUSINESS", tokenNeverExpires: true },
      credentials: { accessToken: "IGAA-system-user-falso" },
    });

    expect(await runRefresh(deps(), account.id, { force: true })).toBe(0);
    expect(h.text()).toContain("Sin cambios: el acceso de @system-user no vence");
  });

  it("refresh: antes de 24 h no cambia y dice desde cuándo; después renueva con el vencimiento real", async () => {
    const { h, deps, connect, advance } = await setup();
    await connect();
    const [account] = await h.platformAccounts.list(ALL_SCOPE);
    const id = account?.id ?? "";

    expect(await runRefresh(deps(), id, { force: true })).toBe(0);
    expect(h.text()).toContain("Sin cambios: @corredora se renovó o conectó hace menos de 24 h");

    advance(25 * HOUR);
    expect(await runRefresh(deps(), id)).toBe(0);
    expect(h.text()).toContain("✓ Acceso de @corredora renovado · vence");
    expect(h.platformAccounts.storedCredentials(id)).toEqual({
      accessToken: `${TOKEN}-refrescado`,
    });
    expect(`${h.text()}\n${h.errors()}`).not.toContain(TOKEN);

    advance(25 * HOUR);
    expect(await runRefresh(deps(), id)).toBe(0);
    expect(h.text()).toContain("le quedan más de 30 días");
    expect(h.text()).toContain("Usa --force");
  });

  it("refresh de una desconectada lo explica; un id que no es uuid se rechaza sin llamar", async () => {
    const { h, deps, connect } = await setup();
    await connect();
    const [account] = await h.platformAccounts.list(ALL_SCOPE);
    await h.platformAccounts.disconnect(account?.id ?? "");

    expect(await runRefresh(deps(), account?.id ?? "")).toBe(1);
    expect(h.errors()).toContain("ACCOUNT_NOT_CONNECTED");
    expect(h.errors()).toContain("Reconéctala con agentsales accounts connect");
    const before = h.requests.length;
    expect(await runRefresh(deps(), "@corredora")).toBe(1);
    expect(h.errors()).toContain("ACCOUNT_ID_INVALID");
    expect(h.requests).toHaveLength(before);
    expect(await runRefresh(deps(), randomUUID())).toBe(1);
    expect(h.errors()).toContain("ACCOUNT_NOT_FOUND");
  });

  it("refresh de Mercado Libre: sin --force espera los 7 días; con --force renueva; un rechazo la deja vencida", async () => {
    const { h, deps, advance } = await setup();
    const broker = (await h.brokers.list(ALL_SCOPE))[0];
    const addMl = (externalAccountId: string, refreshToken: string) =>
      h.platformAccounts.upsertConnected({
        brokerId: broker?.id ?? "",
        platform: "portal_inmobiliario",
        externalAccountId,
        displayName: `CORREDORA_${externalAccountId}`,
        tokenExpiresAt: new Date("2027-04-04T12:00:00Z"),
        meta: {
          userId: externalAccountId,
          nickname: `CORREDORA_${externalAccountId}`,
          siteId: "MLC",
          userType: "normal",
          scopes: ["offline_access", "read", "write"],
          testUser: false,
          connectedAt: "2026-10-06T12:00:00.000Z",
          tokenRefreshedAt: null,
          accessTokenExpiresAt: "2026-10-06T18:00:00.000Z",
          tokenExpiryEstimated: true,
        },
        credentials: { accessToken: `APP_USR-${externalAccountId}`, refreshToken },
      });
    const account = await addMl("8035443", "TG-guardado-8035443");

    expect(await runRefresh(deps(), account.id)).toBe(0);
    expect(h.text()).toContain(
      "Sin cambios: CORREDORA_8035443 se renovó o conectó hace menos de 7 días; toca desde",
    );
    expect(h.text()).toContain("Usa --force");

    expect(await runRefresh(deps(), account.id, { force: true })).toBe(0);
    expect(h.text()).toContain("✓ Acceso de CORREDORA_8035443 renovado · vence");

    advance(7 * 24 * HOUR);
    expect(await runRefresh(deps(), account.id)).toBe(0);
    expect(h.platformAccounts.storedCredentials(account.id)?.refreshToken).toBe(
      "TG-fake-refrescado-2",
    );

    const rejected = await addMl("8035444", "TG-vence-8035444");
    expect(await runRefresh(deps(), rejected.id, { force: true })).toBe(1);
    expect(h.errors()).toContain("✗ Mercado Libre rechazó el acceso de CORREDORA_8035444");
    expect(h.errors()).toContain("Reconéctala");
    expect(`${h.text()}\n${h.errors()}`).not.toMatch(/APP_USR|TG-/);
  });
});

describe("accounts connect mercadolibre (F4-T20, adelantado)", () => {
  const CODE = "TG-codigo-pegado-8035443";

  async function mlSetup(options: { configured?: boolean; secureCookie?: boolean } = {}) {
    const opened: string[] = [];
    const auth = fakeMercadoLibreAuth();
    const h = harness({
      deps: {
        mercadoLibre: {
          auth,
          configured: options.configured ?? true,
          redirectUri: TEST_ML_REDIRECT_URI,
          secureCookie: options.secureCookie ?? false,
        },
      },
    });
    await h.brokers.create(brokerData("marca"));
    const deps = (stdin: string | null = null): AccountsDeps => ({
      ...h.io,
      client: h.client,
      stdinIsTty: () => stdin === null,
      readStdin: async () => stdin ?? "",
      openUrl: (url) => opened.push(url),
      now: () => new Date("2026-10-08T12:00:00Z"),
      confirm: async () => false,
      sleep: async () => {},
      clock: () => 0,
    });
    /** Pide el enlace como lo haría el operador y devuelve el `state` que trae. */
    const freshState = async () => {
      expect(await runConnect(deps(), "mercadolibre", { broker: "marca" })).toBe(0);
      return new URL(opened.at(-1) ?? "").searchParams.get("state") ?? "";
    };
    const paste = (pasted: string) =>
      runConnect(deps(pasted), "mercadolibre", { broker: "marca", urlStdin: true });
    return { h, auth, opened, deps, freshState, paste };
  }

  it("en un servidor con vuelta automática (F8-T19) manda al botón del panel, sin abrir ningún enlace", async () => {
    const { h, opened, deps } = await mlSetup({ secureCookie: true });

    expect(await runConnect(deps(), "mercadolibre", { broker: "marca" })).toBe(1);

    expect(opened).toEqual([]);
    expect(h.errors()).toContain("se conecta con el botón del panel");
  });

  it("sin --url-stdin imprime y abre el enlace de autorización, y dice el paso siguiente", async () => {
    const { h, opened, freshState } = await mlSetup();

    const state = await freshState();

    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^https:\/\/auth\.mercadolibre\.cl\/authorization\?/);
    expect(state.length).toBeGreaterThan(0);
    expect(h.text()).toContain(opened[0]);
    expect(h.text()).toContain("error de conexión: es lo esperado");
    expect(h.text()).toContain(
      "pbpaste | pnpm -s cli accounts connect mercadolibre --broker marca --url-stdin",
    );
  });

  it("con la dirección pegada conecta la cuenta, sin mostrar la dirección ni el código", async () => {
    const { h, freshState, paste } = await mlSetup();
    const state = await freshState();

    const code = await paste(`${TEST_ML_REDIRECT_URI}?code=${CODE}&state=${state}`);

    expect(code).toBe(0);
    expect(h.text()).toContain("✓ Conectada CORREDORA_PRUEBA (marca)");
    expect(h.text()).toContain("Permisos: offline_access, read, write");
    const [account] = await h.platformAccounts.list(ALL_SCOPE);
    expect(account).toMatchObject({ platform: "portal_inmobiliario", status: "connected" });
    const everything = `${h.text()}\n${h.errors()}\n${h.requests.join("\n")}`;
    // El `state` sí está en el enlace del primer paso (no es secreto); el código, nunca.
    expect(everything).not.toContain(CODE);
    expect(h.requests).toContain("POST /accounts/mercadolibre/connect");
  });

  it("en una terminal (sin tubería) no lee: pide pasar la dirección por la entrada estándar", async () => {
    const { h, deps } = await mlSetup();

    const code = await runConnect(deps(null), "mercadolibre", { broker: "marca", urlStdin: true });

    expect(code).toBe(1);
    expect(h.errors()).toContain("URL_STDIN_REQUIRED");
    expect(h.errors()).toContain("--url-stdin");
    expect(h.requests).toEqual([]);
  });

  it.each([
    ["vacía", "  \n", "URL_MISSING"],
    ["con espacios", `${TEST_ML_REDIRECT_URI}?code=${CODE} otra cosa`, "URL_INVALID"],
    ["que no es una dirección", "TG-solo-el-codigo", "URL_INVALID"],
  ])(
    "una entrada %s se rechaza sin llamar a Mercado Libre ni mostrarla",
    async (_, pasted, error) => {
      const { h, auth, paste } = await mlSetup();

      expect(await paste(pasted)).toBe(1);

      expect(h.errors()).toContain(error);
      expect(h.errors()).not.toContain(CODE);
      expect(auth.calls).toEqual([]);
    },
  );

  it("otra dirección (otra pestaña) es URL_NOT_REDIRECT, sin canjear nada", async () => {
    const { h, auth, freshState, paste } = await mlSetup();
    const state = await freshState();

    expect(await paste(`https://otra.test/callback?code=${CODE}&state=${state}`)).toBe(1);

    expect(h.errors()).toContain("URL_NOT_REDIRECT");
    expect(h.errors()).toContain(TEST_ML_REDIRECT_URI);
    expect(h.errors()).not.toContain(CODE);
    expect(auth.calls).toEqual([]);
  });

  it.each([
    ["cancelada", (state: string) => `error=access_denied&state=${state}`, "OAUTH_DENIED"],
    [
      "con error aunque traiga código",
      (state: string) => `error=access_denied&code=${CODE}&state=${state}`,
      "OAUTH_DENIED",
    ],
    ["sin código", (state: string) => `state=${state}`, "URL_INCOMPLETE"],
    ["sin state", () => `code=${CODE}`, "URL_INCOMPLETE"],
    ["con el código vacío", (state: string) => `code=&state=${state}`, "URL_INCOMPLETE"],
  ])("una dirección %s se rechaza sin canjear nada", async (_, query, error) => {
    const { h, auth, freshState, paste } = await mlSetup();
    const state = await freshState();

    expect(await paste(`${TEST_ML_REDIRECT_URI}?${query(state)}`)).toBe(1);

    expect(h.errors()).toContain(error);
    expect(h.errors()).not.toContain(CODE);
    expect(auth.calls).toEqual([]);
  });

  it.each([
    ["con http", TEST_ML_REDIRECT_URI.replace("https://", "http://")],
    ["con otro puerto", TEST_ML_REDIRECT_URI.replace("agentsales.test", "agentsales.test:8443")],
    ["con otra ruta", `${TEST_ML_REDIRECT_URI}/otra`],
    ["con una barra final", `${TEST_ML_REDIRECT_URI}/`],
  ])("una dirección de vuelta %s es URL_NOT_REDIRECT", async (_, base) => {
    const { h, auth, freshState, paste } = await mlSetup();
    const state = await freshState();

    expect(await paste(`${base}?code=${CODE}&state=${state}`)).toBe(1);

    expect(h.errors()).toContain("URL_NOT_REDIRECT");
    expect(auth.calls).toEqual([]);
  });

  it("el host en mayúsculas es la misma dirección", async () => {
    const { h, freshState, paste } = await mlSetup();
    const state = await freshState();
    const upper = TEST_ML_REDIRECT_URI.replace("agentsales.test", "AgentSales.TEST");

    expect(await paste(`${upper}?code=${CODE}&state=${state}`)).toBe(0);
    expect(h.text()).toContain("✓ Conectada");
  });

  it("un --broker inválido da un mensaje claro, sin llamar a la API", async () => {
    const { h, deps } = await mlSetup();

    expect(await runConnect(deps(), "mercadolibre", { broker: "!!!" })).toBe(1);

    expect(h.errors()).toContain("BROKER_INVALID");
    expect(h.requests).toEqual([]);
  });

  it("una opción del otro canal se rechaza en vez de ignorarse", async () => {
    const { h, deps } = await mlSetup();

    expect(await runConnect(deps("x"), "mercadolibre", { broker: "marca", tokenStdin: true })).toBe(
      1,
    );
    expect(await runConnect(deps("x"), "instagram", { broker: "marca", urlStdin: true })).toBe(1);

    expect(h.errors()).toContain("OPTION_NOT_FOR_PLATFORM");
    expect(h.requests).toEqual([]);
  });

  it("un código que Mercado Libre rechaza muestra el mensaje de la API (pedir el enlace de nuevo)", async () => {
    const { h, freshState, paste } = await mlSetup();
    const state = await freshState();

    expect(await paste(`${TEST_ML_REDIRECT_URI}?code=malo-${CODE}&state=${state}`)).toBe(1);

    expect(h.errors()).toContain("ML_AUTH_INVALID");
    expect(h.errors()).toContain("pide el enlace de nuevo");
    expect(h.errors()).not.toContain(CODE);
  });

  it("sin el par de la app en .env: MERCADOLIBRE_NOT_CONFIGURED con el paso a seguir", async () => {
    const { h, opened, deps } = await mlSetup({ configured: false });

    expect(await runConnect(deps(), "mercadolibre", { broker: "marca" })).toBe(1);

    expect(h.errors()).toContain("MERCADOLIBRE_NOT_CONFIGURED");
    expect(h.errors()).toContain("ML_APP_ID");
    expect(opened).toEqual([]);
  });

  it("sin --broker se pide antes de llamar a la API", async () => {
    const { h, deps } = await mlSetup();

    expect(await runConnect(deps(), "mercadolibre", {})).toBe(1);

    expect(h.errors()).toContain("BROKER_REQUIRED");
    expect(h.requests).toEqual([]);
  });
});

describe("accounts connect discord (F9-T14)", () => {
  const WEBHOOK_TOKEN = "tokenSecretoDelWebhook-123_abc";
  const WEBHOOK_URL = `https://discord.com/api/webhooks/987654321/${WEBHOOK_TOKEN}`;

  it("conecta con la URL de la entrada estándar, sin mostrarla ni mandarla en la URL", async () => {
    const { h, deps } = await setup();

    const code = await runConnect(deps(`${WEBHOOK_URL}\n`), "discord", {
      broker: "marca",
      webhookStdin: true,
    });

    expect(code).toBe(0);
    expect(h.text()).toContain("✓ Conectado el webhook AgentSales de Discord (marca)");
    const [account] = await h.platformAccounts.list(ALL_SCOPE);
    expect(h.platformAccounts.storedCredentials(account?.id ?? "")).toEqual({
      webhookUrl: WEBHOOK_URL,
    });
    expect(h.requests).toContain("POST /accounts/discord/connect");
    expect(`${h.text()}\n${h.errors()}\n${h.requests.join("\n")}`).not.toContain(WEBHOOK_TOKEN);
  });

  it("sin --webhook-stdin o en una terminal no lee: pide pasarla por la entrada estándar", async () => {
    const { h, deps } = await setup();
    expect(await runConnect(deps(WEBHOOK_URL), "discord", { broker: "marca" })).toBe(1);
    expect(await runConnect(deps(null), "discord", { broker: "marca", webhookStdin: true })).toBe(
      1,
    );
    expect(h.errors()).toContain("WEBHOOK_STDIN_REQUIRED");
    expect(h.errors()).toContain(
      "pbpaste | pnpm -s cli accounts connect discord --broker marca --webhook-stdin",
    );
    expect(h.requests).toEqual([]);
  });

  it("vacío, otra cosa pegada u opciones de otro canal se rechazan sin llamar ni mostrar lo pegado", async () => {
    const { h, deps } = await setup();
    const cases: [Promise<number>, string][] = [
      [
        runConnect(deps("  \n"), "discord", { broker: "marca", webhookStdin: true }),
        "WEBHOOK_URL_MISSING",
      ],
      [
        runConnect(deps("https://example.com/api/webhooks/1/otroSecreto"), "discord", {
          broker: "marca",
          webhookStdin: true,
        }),
        "DISCORD_WEBHOOK_URL_INVALID",
      ],
      [
        runConnect(deps(`${WEBHOOK_URL}\notra-linea`), "discord", {
          broker: "marca",
          webhookStdin: true,
        }),
        "DISCORD_WEBHOOK_URL_INVALID",
      ],
      [
        runConnect(deps(WEBHOOK_URL), "discord", { broker: "marca", tokenStdin: true }),
        "OPTION_NOT_FOR_PLATFORM",
      ],
      [
        runConnect(deps(WEBHOOK_URL), "instagram", { broker: "marca", webhookStdin: true }),
        "OPTION_NOT_FOR_PLATFORM",
      ],
    ];
    for (const [result, code] of cases) {
      expect(await result).toBe(1);
      expect(h.errors()).toContain(code);
    }
    expect(h.errors()).not.toContain("otroSecreto");
    expect(h.errors()).not.toContain(WEBHOOK_TOKEN);
    expect(h.requests).toEqual([]);
  });

  it("un webhook borrado muestra el mensaje de la API, sin la URL", async () => {
    const { h, deps } = await setup();
    const code = await runConnect(
      deps("https://discord.com/api/webhooks/987654321/borradoToken"),
      "discord",
      { broker: "marca", webhookStdin: true },
    );
    expect(code).toBe(1);
    expect(h.errors()).toContain("DISCORD_WEBHOOK_NOT_FOUND");
    expect(h.errors()).not.toContain("borradoToken");
  });
});

describe("accounts connect x y accounts spend-limit (F9-T16)", () => {
  async function xSetup(options: { configured?: boolean } = {}) {
    const opened: string[] = [];
    const h = harness({
      deps: {
        x: {
          auth: fakeXAuth(),
          configured: options.configured ?? true,
          secureCookie: false,
          pkce: () => ({ verifier: "v".repeat(43), challenge: "c" }),
          // Distinto del que escribiría alguien a mano: el enlace tiene que venir de la API.
          startUrl: "http://127.0.0.1:8787/api/oauth/x/start",
        },
      },
    });
    const brand = await h.brokers.create(brokerData("marca"));
    const deps = (): AccountsDeps => ({
      ...h.io,
      client: h.client,
      stdinIsTty: () => true,
      readStdin: async () => "",
      openUrl: (url) => opened.push(url),
      now: () => new Date("2026-10-20T12:00:00Z"),
      confirm: async () => false,
      sleep: async () => {},
      clock: () => 0,
    });
    return { h, deps, opened, brand };
  }

  it("imprime y abre el inicio del OAuth de X que da la API, con la marca", async () => {
    const { h, deps, opened } = await xSetup();
    expect(await runConnect(deps(), "x", { broker: "Marca" })).toBe(0);
    expect(opened).toEqual(["http://127.0.0.1:8787/api/oauth/x/start?broker=marca"]);
    expect(h.text()).toContain(opened[0]);
    expect(h.text()).toContain("127.0.0.1");
  });

  it("sin el par de la app, una opción de otro canal o sin --broker, no abre nada", async () => {
    const off = await xSetup({ configured: false });
    expect(await runConnect(off.deps(), "x", { broker: "marca" })).toBe(1);
    expect(off.h.errors()).toContain("X_NOT_CONFIGURED");
    const { h, deps, opened } = await xSetup();
    expect(await runConnect(deps(), "x", { broker: "marca", tokenStdin: true })).toBe(1);
    expect(h.errors()).toContain("OPTION_NOT_FOR_PLATFORM");
    expect(await runConnect(deps(), "x", {})).toBe(1);
    expect(h.errors()).toContain("BROKER_REQUIRED");
    expect(opened).toEqual([]);
  });

  it("spend-limit fija el tope en dólares (acepta coma) y accounts lo muestra", async () => {
    const { h, deps, brand } = await xSetup();
    const account = await h.platformAccounts.upsertConnected({
      brokerId: brand.id,
      platform: "x",
      externalAccountId: "12345",
      displayName: "@agentpey",
      tokenExpiresAt: null,
      meta: {
        userId: "12345",
        username: "agentpey",
        scopes: ["tweet.write", "media.write", "offline.access"],
        connectedAt: "2026-10-20T12:00:00.000Z",
        tokenRefreshedAt: null,
        accessTokenExpiresAt: "2026-10-20T14:00:00.000Z",
      },
      credentials: { accessToken: "access-x", refreshToken: "refresh-x" },
    });
    expect(await runAccounts(deps())).toBe(0);
    expect(h.text()).toContain("tope de gasto en X de US$10 al mes");
    expect(await runSpendLimit(deps(), account.id, "2,5")).toBe(0);
    expect(h.text()).toContain("US$2,5 al mes");
    expect(await runSpendLimit(deps(), account.id, "mucho")).toBe(1);
    expect(h.errors()).toContain("X_SPEND_LIMIT_INVALID");
    expect(await runSpendLimit(deps(), account.id, "5000")).toBe(1);
    expect(h.errors()).toContain("1.000");
  });
});

describe("accounts connect linkedin y accounts mode (F9-T15)", () => {
  async function linkedinSetup(options: { configured?: boolean; confirm?: boolean } = {}) {
    const opened: string[] = [];
    const h = harness({
      deps: {
        linkedin: {
          auth: fakeLinkedInAuth(),
          configured: options.configured ?? true,
          secureCookie: false,
          // Distinto del que escribiría alguien a mano: el enlace tiene que venir de la API.
          startUrl: "https://agentsales.test/api/oauth/linkedin/start",
        },
      },
    });
    const broker = await h.brokers.create(brokerData("marca"));
    const deps = (): AccountsDeps => ({
      ...h.io,
      client: h.client,
      stdinIsTty: () => true,
      readStdin: async () => "",
      openUrl: (url) => opened.push(url),
      now: () => new Date("2026-10-20T12:00:00Z"),
      confirm: async () => options.confirm ?? false,
      sleep: async () => {},
      clock: () => 0,
    });
    const linkedin = () =>
      h.platformAccounts.upsertConnected(
        {
          brokerId: broker.id,
          platform: "linkedin",
          externalAccountId: "miembro-123",
          displayName: "Vicente Wolde",
          tokenExpiresAt: new Date("2026-12-19T12:00:00Z"),
          meta: { mode: "manual", scopes: null, connectedAt: "2026-10-20T12:00:00.000Z" },
          credentials: { accessToken: "token-linkedin-de-prueba" },
        },
        { revokeOthers: true },
      );
    return { h, deps, opened, linkedin };
  }

  it("connect linkedin abre el inicio del OAuth que da la API, con el corredor", async () => {
    const { h, deps, opened } = await linkedinSetup();
    expect(await runConnect(deps(), "linkedin", { broker: "marca" })).toBe(0);
    const url = "https://agentsales.test/api/oauth/linkedin/start?broker=marca";
    expect(opened).toEqual([url]);
    expect(h.text()).toContain(url);
    expect(h.text()).toContain("a mano");
  });

  it("sin la app de LinkedIn en la API: LINKEDIN_NOT_CONFIGURED, sin abrir nada", async () => {
    const { h, deps, opened } = await linkedinSetup({ configured: false });
    expect(await runConnect(deps(), "linkedin", { broker: "marca" })).toBe(1);
    expect(h.errors()).toContain("LINKEDIN_NOT_CONFIGURED");
    expect(opened).toEqual([]);
  });

  it("una opción de otro canal no se ignora", async () => {
    const { h, deps } = await linkedinSetup();
    expect(await runConnect(deps(), "linkedin", { broker: "marca", tokenStdin: true })).toBe(1);
    expect(h.errors()).toContain("OPTION_NOT_FOR_PLATFORM");
  });

  it("accounts muestra la cuenta de LinkedIn a mano", async () => {
    const { h, deps, linkedin } = await linkedinSetup();
    await linkedin();
    expect(await runAccounts(deps())).toBe(0);
    expect(h.text()).toContain("LinkedIn (a mano)");
    expect(h.text()).not.toContain("token-linkedin-de-prueba");
  });

  it("mode api pregunta antes; con --yes cambia, y manual vuelve sin preguntar", async () => {
    const { h, deps, linkedin } = await linkedinSetup();
    const account = await linkedin();

    expect(await runMode(deps(), account.id, "api")).toBe(1);
    expect(h.errors()).toContain("No se cambió el modo");
    expect((await h.platformAccounts.get(account.id))?.meta.mode).toBe("manual");

    expect(await runMode(deps(), account.id, "api", { yes: true })).toBe(0);
    expect(h.text()).toContain("✓ Vicente Wolde (LinkedIn) publica por API");
    expect((await h.platformAccounts.get(account.id))?.meta.mode).toBe("api");

    expect(await runMode(deps(), account.id, "manual")).toBe(0);
    expect(h.text()).toContain("publica a mano");
    expect(await runMode(deps(), account.id, "manual")).toBe(0);
    expect(h.text()).toContain("Sin cambios");
  });

  it("mode con un modo o un id que no sirven no llama a la API", async () => {
    const { h, deps, linkedin } = await linkedinSetup();
    const account = await linkedin();
    expect(await runMode(deps(), account.id, "auto")).toBe(1);
    expect(h.errors()).toContain("MODE_INVALID");
    expect(await runMode(deps(), "no-es-un-id", "manual")).toBe(1);
    expect(h.errors()).toContain("ACCOUNT_ID_INVALID");
    expect(h.requests).toEqual([]);
  });
});
