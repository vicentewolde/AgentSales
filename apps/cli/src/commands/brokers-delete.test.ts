import { randomUUID } from "node:crypto";
import { testStorage } from "@agentsales/api/testing";
import { AppError } from "@agentsales/core";
import { createFakeBrokerPurgeRepository } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { brokerData, harness } from "../../test/harness.js";
import { runBrokerDelete } from "./brokers.js";

// F9.5-T14 (ADR-0035): `agentsales brokers delete <slug> --confirm <slug>` contra la API en proceso.
// Lo que borra la base lo prueba el repositorio con PGlite; aquí, el resumen y la confirmación.

const BROKER_TOKEN = "token-del-corredor-que-se-borra";

async function setup() {
  const brokerPurge = createFakeBrokerPurgeRepository();
  const h = harness({ deps: { brokerPurge } });
  const broker = await h.brokers.create(brokerData("prueba"));
  await h.brokers.create(brokerData("otro"));
  brokerPurge.set(broker.id, {
    counts: {
      listings: 3,
      media: 42,
      publications: 5,
      livePublications: 2,
      posts: 2,
      users: 1,
      accounts: 2,
    },
    refs: { mediaKeys: [`brokers/${broker.id}/brand/logo.png`] },
    deleted: { brokers: 1, listings: 3, media: 42, sessions: 0 },
  });
  await h.storage.put(`brokers/${broker.id}/brand/logo.png`, new Uint8Array([1]), "image/png");
  const deps = { ...h.io, client: h.client, confirm: async () => true };
  return { h, broker, brokerPurge, deps };
}

describe("brokers delete", () => {
  it("sin --confirm muestra el resumen y cómo confirmar, sin borrar nada", async () => {
    const s = await setup();
    expect(await runBrokerDelete(s.deps, "prueba")).toBe(1);
    const out = s.h.text();
    expect(out).toContain("Marca prueba (prueba): se borra todo lo suyo");
    expect(out).toMatch(/3 {2}propiedades/);
    expect(out).toMatch(/42 {2}fotos, videos y logos/);
    expect(out).toMatch(/1 {2}usuarios con sus sesiones/);
    expect(out).toMatch(/2 {2}cuentas conectadas/);
    expect(out).toContain(
      "2 publicaciones están publicadas o pausadas: seguirán publicadas en las redes",
    );
    expect(s.h.errors()).toContain("agentsales brokers delete prueba --confirm prueba");
    expect(s.h.errors()).toContain("pnpm db:backup");
    expect(s.brokerPurge.purged).toEqual([]);
  });

  it("--confirm con otro slug no borra nada", async () => {
    const s = await setup();
    expect(await runBrokerDelete(s.deps, "prueba", { confirm: "otro" })).toBe(1);
    expect(s.h.errors()).toContain("CONFIRM_MISMATCH");
    expect(s.brokerPurge.purged).toEqual([]);
  });

  it("con --confirm igual al slug borra y dice qué se borró", async () => {
    const s = await setup();
    expect(await runBrokerDelete(s.deps, "prueba", { confirm: "prueba" })).toBe(0);
    expect(s.brokerPurge.purged).toEqual([s.broker.id]);
    const out = s.h.text();
    expect(out).toContain("Corredor prueba borrado: 46 filas en la base");
    expect(out).toMatch(/42 {2}media/);
    // Las tablas sin filas no se listan.
    expect(out).not.toMatch(/sessions/);
    expect(out).toContain("1 archivos borrados en R2");
    expect(s.h.storage.objects.has(`brokers/${s.broker.id}/brand/logo.png`)).toBe(false);
  });

  it("con publicaciones en curso o programadas no borra y dice qué hacer", async () => {
    const s = await setup();
    const publicationId = randomUUID();
    s.brokerPurge.set(s.broker.id, {
      blocking: [{ publicationId, status: "scheduled", platform: "instagram" }],
    });
    expect(await runBrokerDelete(s.deps, "prueba", { confirm: "prueba" })).toBe(1);
    expect(s.h.errors()).toContain(publicationId);
    expect(s.h.errors()).toContain("unschedule");
    expect(s.brokerPurge.purged).toEqual([]);
  });

  it("lo que R2 no borró queda en la salida, con su clave", async () => {
    const brokerPurge = createFakeBrokerPurgeRepository();
    const storage = testStorage();
    const failing = harness({
      deps: {
        brokerPurge,
        storage: {
          ...storage,
          delete: async () => {
            throw new AppError("STORAGE_UNAVAILABLE", "R2 no respondió", { retriable: true });
          },
        },
      },
    });
    const broker = await failing.brokers.create(brokerData("prueba"));
    const key = `brokers/${broker.id}/brand/logo.png`;
    await storage.put(key, new Uint8Array([1]), "image/png");
    brokerPurge.set(broker.id, { refs: { mediaKeys: [key] } });
    const deps = { ...failing.io, client: failing.client, confirm: async () => true };
    expect(await runBrokerDelete(deps, "prueba", { confirm: "prueba" })).toBe(0);
    expect(failing.errors()).toContain("Quedaron 1 pendientes en R2");
    expect(failing.errors()).toContain(`${key}  STORAGE_UNAVAILABLE`);
  });

  it("un corredor no puede borrar ni el suyo", async () => {
    const s = await setup();
    const user = s.h.auth.repos.seed.user({
      email: "corredor-prueba@ejemplo.cl",
      name: "Corredor",
      role: "broker",
      brokerId: s.broker.id,
    });
    s.h.auth.repos.seed.session({
      userId: user.id,
      tokenHash: s.h.auth.tokens.hash(BROKER_TOKEN),
      client: "cli",
    });
    const deps = { ...s.deps, client: s.h.clientWith(BROKER_TOKEN) };
    expect(await runBrokerDelete(deps, "prueba", { confirm: "prueba" })).toBe(1);
    expect(s.h.errors()).toContain("FORBIDDEN");
    expect(s.brokerPurge.purged).toEqual([]);
  });
});
