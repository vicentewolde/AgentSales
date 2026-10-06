import { randomUUID } from "node:crypto";
import { fakeInstagramAuth } from "@agentsales/api/testing";
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
    },
  });
  await h.brokers.create(brokerData("marca"));
  const deps = (stdin: string | null = TOKEN): AccountsDeps => ({
    ...h.io,
    client: h.client,
    stdinIsTty: () => stdin === null,
    readStdin: async () => stdin ?? "",
    openUrl: (url) => opened.push(url),
    oauthStartUrl: (broker) => `http://localhost:8787/oauth/instagram/start?broker=${broker}`,
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
    expect(opened).toEqual(["http://localhost:8787/oauth/instagram/start?broker=marca"]);
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
});
