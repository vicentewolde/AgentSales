import { AppError, type TikTokAuth } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { brokerData, harness } from "../../test/harness.js";
import { type AccountsDeps, runConnect } from "./accounts.js";

// F9-T26: `accounts connect tiktok --broker <slug>` abre el inicio de Login Kit que da la API.

const unusedTikTok: TikTokAuth = {
  authorizeUrl: (state) => `https://www.tiktok.com/v2/auth/authorize/?state=${state}`,
  exchangeCode: async () => {
    throw new AppError("TIKTOK_AUTH_INVALID", "no se usa aquí");
  },
  user: async () => ({ openId: "x", displayName: "x" }),
  refresh: async () => {
    throw new AppError("TIKTOK_AUTH_INVALID", "no se usa aquí");
  },
  isRejected: () => false,
};

async function setup(options: { configured?: boolean; withTikTok?: boolean } = {}) {
  const opened: string[] = [];
  const h = harness({
    deps:
      options.withTikTok === false
        ? {}
        : {
            tiktok: {
              auth: unusedTikTok,
              configured: options.configured ?? true,
              secureCookie: true,
              // Distinto del que escribiría alguien a mano: el enlace tiene que venir de la API.
              startUrl: "https://agentsales.test/api/oauth/tiktok/start",
            },
          },
  });
  await h.brokers.create(brokerData("marca"));
  const deps: AccountsDeps = {
    ...h.io,
    client: h.client,
    stdinIsTty: () => true,
    readStdin: async () => "",
    openUrl: (url) => opened.push(url),
    now: () => new Date("2026-10-20T12:00:00Z"),
    confirm: async () => false,
    sleep: async () => {},
    clock: () => 0,
  };
  return { h, deps, opened };
}

describe("accounts connect tiktok (F9-T26)", () => {
  it("imprime y abre el inicio del OAuth que da la API, con el corredor", async () => {
    const { h, deps, opened } = await setup();

    expect(await runConnect(deps, "TikTok", { broker: "Marca" })).toBe(0);

    expect(opened).toEqual(["https://agentsales.test/api/oauth/tiktok/start?broker=marca"]);
    expect(h.text()).toContain(opened[0]);
    expect(h.text()).toContain("sesión del panel");
  });

  it("sin la app de TikTok en la API: TIKTOK_NOT_CONFIGURED, sin abrir nada", async () => {
    for (const options of [{ configured: false }, { withTikTok: false }]) {
      const { h, deps, opened } = await setup(options);

      expect(await runConnect(deps, "tiktok", { broker: "marca" })).toBe(1);
      expect(h.errors()).toContain("TIKTOK_NOT_CONFIGURED");
      expect(opened).toEqual([]);
    }
  });

  it("una opción de otro canal no se ignora", async () => {
    const { h, deps, opened } = await setup();

    expect(await runConnect(deps, "tiktok", { broker: "marca", tokenStdin: true })).toBe(1);
    expect(h.errors()).toContain("OPTION_NOT_FOR_PLATFORM");
    expect(opened).toEqual([]);
  });
});
