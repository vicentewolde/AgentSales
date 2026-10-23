import type { PublishMode } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { brokerData, harness } from "../../test/harness.js";
import { runBrokerLive, runBrokerShow } from "./brokers.js";

// F9.5-T22 (ADR-0036): `agentsales brokers live <slug> on|off`, contra la API real en proceso.

const BROKER_TOKEN = "token-del-corredor-live";

async function setup(publishMode: PublishMode = "dry-run") {
  const h = harness({ deps: { publishMode } });
  const own = await h.brokers.create(brokerData("vinny"), { kind: "brand" });
  await h.brokers.setSettings(own.id, { operatorOwned: true });
  const client = await h.brokers.create(brokerData("cliente"));
  const asked: string[] = [];
  const deps = {
    ...h.io,
    client: h.client,
    confirm: async (question: string) => {
      asked.push(question);
      return true;
    },
  };
  const asBroker = () => {
    const user = h.auth.repos.seed.user({
      email: "marca-live@ejemplo.cl",
      name: "Marca",
      role: "broker",
      brokerId: own.id,
    });
    h.auth.repos.seed.session({
      userId: user.id,
      tokenHash: h.auth.tokens.hash(BROKER_TOKEN),
      client: "cli",
    });
    return { ...deps, client: h.clientWith(BROKER_TOKEN) };
  };
  return { h, own, client, deps, asked, asBroker };
}

describe("runBrokerLive", () => {
  it("encender exige --confirm <slug>: con --yes solo no basta, y no cambia nada", async () => {
    const s = await setup("live");
    await expect(runBrokerLive(s.deps, "vinny", "on", { yes: true })).resolves.toBe(1);
    expect(s.h.errors()).toContain("--confirm vinny");
    await expect(
      runBrokerLive(s.deps, "vinny", "on", { yes: true, confirm: "otra" }),
    ).resolves.toBe(1);
    expect((await s.h.brokers.findById(s.own.id))?.liveEnabled).toBe(false);
    expect(s.asked).toEqual([]);
  });

  it("enciende con el servidor en vivo: pregunta, dice el modo del servidor y la marca queda en vivo", async () => {
    const s = await setup("live");
    await expect(runBrokerLive(s.deps, "vinny", "on", { confirm: "vinny" })).resolves.toBe(0);
    expect(s.asked[0]).toContain("PUBLISH_MODE=live");
    expect(s.h.errors()).toContain("lo que publiques en vinny sale de verdad");
    expect(s.h.text()).toContain("Modo en vivo de vinny: encendido. Hoy publica de verdad.");
    expect((await s.h.brokers.findById(s.own.id))?.liveEnabled).toBe(true);
  });

  it("con el servidor en simulación enciende pero avisa que nada sale de verdad", async () => {
    const s = await setup("dry-run");
    await expect(
      runBrokerLive(s.deps, "vinny", "on", { confirm: "vinny", yes: true }),
    ).resolves.toBe(0);
    expect(s.h.errors()).toContain(
      "nada sale de verdad hasta que el operador ponga PUBLISH_MODE=live",
    );
    expect(s.h.text()).toContain("Hoy publica en simulación: el servidor está en dry-run.");
    expect((await s.h.brokers.findById(s.own.id))?.liveEnabled).toBe(true);
  });

  it("apagar pide confirmación (--yes la salta) y no pide el slug; si dices que no, no cambia", async () => {
    const s = await setup("live");
    await runBrokerLive(s.deps, "vinny", "on", { confirm: "vinny", yes: true });
    const no = { ...s.deps, confirm: async () => false };
    await expect(runBrokerLive(no, "vinny", "off")).resolves.toBe(1);
    expect((await s.h.brokers.findById(s.own.id))?.liveEnabled).toBe(true);
    await expect(runBrokerLive(s.deps, "vinny", "off", { yes: true })).resolves.toBe(0);
    expect(s.h.text()).toContain("Modo en vivo de vinny: apagado. Hoy publica en simulación.");
    expect((await s.h.brokers.findById(s.own.id))?.liveEnabled).toBe(false);
  });

  it("un corredor que no es propio no se enciende, con un mensaje claro y sin llamar a la API", async () => {
    const s = await setup("live");
    await expect(
      runBrokerLive(s.deps, "cliente", "on", { confirm: "cliente", yes: true }),
    ).resolves.toBe(1);
    expect(s.h.errors()).toContain("cliente no es un corredor propio");
    expect((await s.h.brokers.findById(s.client.id))?.liveEnabled).toBe(false);
  });

  it("solo el administrador: el corredor, aunque sea su marca, recibe el aviso de la API", async () => {
    const s = await setup("live");
    await expect(
      runBrokerLive(s.asBroker(), "vinny", "on", { confirm: "vinny", yes: true }),
    ).resolves.toBe(1);
    expect(s.h.errors()).toContain("administrador");
    expect((await s.h.brokers.findById(s.own.id))?.liveEnabled).toBe(false);
  });

  it("on u off; otra palabra no llama a nada; un slug que no existe es BROKER_NOT_FOUND", async () => {
    const s = await setup();
    await expect(runBrokerLive(s.deps, "vinny", "quizás")).resolves.toBe(1);
    expect(s.h.errors()).toContain("Usa on u off");
    await expect(runBrokerLive(s.deps, "nadie", "off", { yes: true })).resolves.toBe(1);
    expect(s.h.errors()).toContain("No existe el corredor nadie");
  });

  it("show dice si la marca está en vivo y qué modo tiene hoy", async () => {
    const s = await setup("live");
    await runBrokerShow(s.deps, "vinny");
    expect(s.h.text()).toContain("Modo en vivo: apagado · Hoy publica en simulación.");
    await runBrokerLive(s.deps, "vinny", "on", { confirm: "vinny", yes: true });
    await runBrokerShow(s.deps, "vinny");
    expect(s.h.text()).toContain("Modo en vivo: encendido · Hoy publica de verdad.");
  });
});
