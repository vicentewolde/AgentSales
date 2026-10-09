import { randomUUID } from "node:crypto";
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
const sim = useMercadoLibreSim();

async function setup(
  options: {
    reply?: () => Response;
    clipboard?: boolean;
    copyFails?: boolean;
    account?: boolean;
    testUser?: boolean;
  } = {},
) {
  sim.server.use(
    http.post(
      `${API}/users/test_user`,
      options.reply ??
        (() =>
          HttpResponse.json(
            { id: 1234567890, nickname: "TESTUSER123", password: PASSWORD, site_status: "active" },
            { status: 201 },
          )),
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
        mercadoLibre: null,
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
      { brokerSlug: slug },
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
});
