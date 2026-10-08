import { randomUUID } from "node:crypto";
import {
  fakeInstagramAuth,
  fakeMercadoLibreAuth,
  TEST_ML_REDIRECT_URI,
} from "@agentsales/api/testing";
import { describe, expect, it } from "vitest";
import { brokerData, harness } from "../../test/harness.js";
import {
  type AccountsDeps,
  type ConnectOptions,
  runAccounts,
  runConnect,
  runRefresh,
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
    const [account] = await h.platformAccounts.list();
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

  it("refresh: antes de 24 h no cambia y dice desde cuándo; después renueva con el vencimiento real", async () => {
    const { h, deps, connect, advance } = await setup();
    await connect();
    const [account] = await h.platformAccounts.list();
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
    const [account] = await h.platformAccounts.list();
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
    const broker = (await h.brokers.list())[0];
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

  async function mlSetup(options: { configured?: boolean } = {}) {
    const opened: string[] = [];
    const auth = fakeMercadoLibreAuth();
    const h = harness({
      deps: {
        mercadoLibre: {
          auth,
          configured: options.configured ?? true,
          redirectUri: TEST_ML_REDIRECT_URI,
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
    const [account] = await h.platformAccounts.list();
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

  it("una autorización cancelada es OAUTH_DENIED; sin código o sin state, URL_INCOMPLETE", async () => {
    const { h, auth, freshState, paste } = await mlSetup();
    const state = await freshState();

    expect(await paste(`${TEST_ML_REDIRECT_URI}?error=access_denied&state=${state}`)).toBe(1);
    expect(h.errors()).toContain("OAUTH_DENIED");
    expect(await paste(`${TEST_ML_REDIRECT_URI}?state=${state}`)).toBe(1);
    expect(await paste(`${TEST_ML_REDIRECT_URI}?code=${CODE}`)).toBe(1);
    expect(h.errors()).toContain("URL_INCOMPLETE");
    expect(auth.calls).toEqual([]);
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
