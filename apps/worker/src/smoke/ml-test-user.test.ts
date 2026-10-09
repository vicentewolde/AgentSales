import { randomUUID } from "node:crypto";
import type { MercadoLibreAuth } from "@agentsales/core";
import { createPublicationScenario, PORTAL_SCENARIO_TOKENS } from "@agentsales/core/testing";
import { createMercadoLibreTestUsers } from "@agentsales/publishers";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { useMercadoLibreSim } from "../../test/mercadolibre-sim.js";
import { runMlTestUser } from "./ml-test-user.js";

// F4-T25: `pnpm ml:test-user` contra un Mercado Libre simulado (msw): un solo POST, y la clave solo
// va al portapapeles (nunca a la salida).

const API = "https://api.mercadolibre.com";
const PASSWORD = "clave-qwerty-1234";
const NEW_ACCESS = "APP_USR-6543210987654321-100912-aaaabbbbccccddddeeeeffff00001111-8035443";
const CREATED = () =>
  HttpResponse.json(
    { id: 1234567890, nickname: "TESTUSER123", password: PASSWORD, site_status: "active" },
    { status: 201 },
  );
const sim = useMercadoLibreSim();

/** Un refresco de Mercado Libre falso: entrega el par nuevo para la misma cuenta. */
function fakeAuth() {
  const calls: string[] = [];
  const auth: MercadoLibreAuth = {
    authorizeUrl: () => "https://auth.mercadolibre.cl/authorization",
    exchangeCode: async () => {
      throw new Error("no se canjea en esta prueba");
    },
    me: async () => {
      throw new Error("no se lee el usuario en esta prueba");
    },
    refresh: async () => {
      calls.push("refresh");
      return {
        accessToken: NEW_ACCESS,
        refreshToken: "TG-0f1e2d3c4b5a69788796a5b4-8035443",
        accessTokenExpiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
        scopes: ["offline_access", "read", "write"],
        userId: "8035443",
      };
    },
  };
  return { auth, calls };
}

async function setup(
  options: {
    reply?: (request: Request) => Response | Promise<Response>;
    clipboard?: boolean;
    copyFails?: boolean;
    account?: boolean;
    testUser?: boolean;
    auth?: MercadoLibreAuth | null;
    signal?: AbortSignal;
  } = {},
) {
  sim.server.use(
    http.post(`${API}/users/test_user`, ({ request }) =>
      options.reply === undefined ? CREATED() : options.reply(request),
    ),
  );
  const t = await createPublicationScenario({
    platform: "portal_inmobiliario",
    nextId: randomUUID,
    account: options.account ?? true,
    approve: false,
  });
  if (options.testUser) {
    const [account] = await t.platformAccounts.list();
    if (account === undefined) throw new Error("falta la cuenta");
    await t.platformAccounts.upsertConnected({
      brokerId: account.brokerId,
      platform: "portal_inmobiliario",
      externalAccountId: account.externalAccountId,
      displayName: "TESTUSER999",
      tokenExpiresAt: account.tokenExpiresAt,
      meta: { ...account.meta, testUser: true },
      credentials: { ...PORTAL_SCENARIO_TOKENS },
    });
  }
  const copied: string[] = [];
  const out: string[] = [];
  const brokers = await t.brokers.list();
  const slug = brokers[0]?.slug ?? "";
  const run = () =>
    runMlTestUser(
      {
        accounts: t.platformAccounts,
        brokers: t.brokers,
        mercadoLibre: options.auth ?? null,
        testUsers: createMercadoLibreTestUsers(),
        clipboardReady: async () => options.clipboard ?? true,
        copyToClipboard: async (text) => {
          if (options.copyFails) throw new Error("pbcopy falló");
          copied.push(text);
        },
        now: () => new Date(),
        print: (line) => out.push(line),
        printError: (line) => out.push(line),
      },
      { brokerSlug: slug, ...(options.signal === undefined ? {} : { signal: options.signal }) },
    );
  const posts = async () =>
    (await sim.recorded()).filter((r) => r.method === "POST" && r.path === "/users/test_user");
  return { t, run, copied, text: () => out.join("\n"), posts };
}

describe("ml:test-user", () => {
  it("crea el usuario con un solo POST: muestra id y apodo; la clave solo va al portapapeles", async () => {
    const s = await setup();

    expect(await s.run()).toBe(0);
    expect(s.text()).toContain("✓ Usuario de prueba creado: TESTUSER123 (id 1234567890)");
    expect(s.text()).toContain("No se puede recuperar");
    expect(s.copied).toEqual([PASSWORD]);
    expect(s.text()).not.toContain(PASSWORD);
    const posts = await s.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.json).toEqual({ site_id: "MLC" });
  });

  it("sin portapapeles no crea nada: la clave se perdería", async () => {
    const s = await setup({ clipboard: false });

    expect(await s.run()).toBe(1);
    expect(s.text()).toContain("CLIPBOARD_UNAVAILABLE");
    expect(await s.posts()).toEqual([]);
  });

  it("si Mercado Libre no responde bien, avisa que pudo crearse y no reintenta", async () => {
    const s = await setup({
      reply: () => HttpResponse.json({ message: "boom" }, { status: 503 }),
    });

    expect(await s.run()).toBe(1);
    expect(s.text()).toContain("pudo haberse creado");
    expect(await s.posts()).toHaveLength(1);
    expect(s.copied).toEqual([]);
  });

  it("si la clave no se puede copiar después de crear, lo dice sin mostrarla", async () => {
    const s = await setup({ copyFails: true });

    expect(await s.run()).toBe(1);
    expect(s.text()).toContain("Se creó el usuario TESTUSER123");
    expect(s.text()).not.toContain(PASSWORD);
  });

  it("se niega si la cuenta conectada ya es un usuario de prueba", async () => {
    const s = await setup({ testUser: true });

    expect(await s.run()).toBe(1);
    expect(s.text()).toContain("ACCOUNT_IS_TEST_USER");
    expect(await s.posts()).toEqual([]);
  });

  it("sin cuenta conectada lo dice sin llamar", async () => {
    const s = await setup({ account: false });

    expect(await s.run()).toBe(1);
    expect(s.text()).toContain("ACCOUNT_NOT_CONNECTED");
    expect(await s.posts()).toEqual([]);
  });

  it("un 401 se refresca y se repite una vez (no había creado nada): dos POST como mucho", async () => {
    const { auth, calls } = fakeAuth();
    const s = await setup({
      auth,
      reply: (request) =>
        request.headers.get("authorization") === `Bearer ${NEW_ACCESS}`
          ? CREATED()
          : HttpResponse.json({ message: "invalid token", error: "unauthorized" }, { status: 401 }),
    });

    expect(await s.run()).toBe(0);
    expect(calls).toEqual(["refresh"]);
    expect(await s.posts()).toHaveLength(2);
    expect(s.copied).toEqual([PASSWORD]);
    const [account] = await s.t.platformAccounts.list();
    expect(account?.status).toBe("connected");
    // El par nuevo quedó guardado (con el candado): el refresco no deja tokens viejos.
    const credentials = await s.t.platformAccounts.getCredentials(account?.id ?? "");
    expect(credentials).toMatchObject({ accessToken: NEW_ACCESS });
  });

  it("una respuesta con otra forma que trae la clave: pudo crearse, y la clave no se muestra", async () => {
    const s = await setup({
      reply: () => HttpResponse.json({ id: "no-es-numero", password: PASSWORD }),
    });

    expect(await s.run()).toBe(1);
    expect(s.text()).toContain("pudo haberse creado");
    expect(s.text()).not.toContain(PASSWORD);
    expect(await s.posts()).toHaveLength(1);
  });

  it("un corte en vuelo (Ctrl+C) avisa que pudo crearse y no repite", async () => {
    const controller = new AbortController();
    const s = await setup({
      signal: controller.signal,
      reply: async () => {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return CREATED();
      },
    });

    expect(await s.run()).toBe(1);
    expect(s.text()).toContain("ML_ABORTED");
    expect(s.text()).toContain("pudo haberse creado");
    expect(s.text()).not.toContain(PASSWORD);
    expect(s.copied).toEqual([]);
  });

  it("con el acceso vencido y sin el par de la app: lo dice sin crear nada", async () => {
    const s = await setup();
    const [account] = await s.t.platformAccounts.list();
    if (account === undefined) throw new Error("falta la cuenta");
    await s.t.platformAccounts.upsertConnected({
      brokerId: account.brokerId,
      platform: "portal_inmobiliario",
      externalAccountId: account.externalAccountId,
      displayName: account.displayName,
      tokenExpiresAt: account.tokenExpiresAt,
      meta: { ...account.meta, accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() },
      credentials: { ...PORTAL_SCENARIO_TOKENS },
    });

    expect(await s.run()).toBe(1);
    expect(s.text()).toContain("MERCADOLIBRE_NOT_CONFIGURED");
    expect(await s.posts()).toEqual([]);
  });
});
