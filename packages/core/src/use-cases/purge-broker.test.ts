import { describe, expect, it } from "vitest";
import type { BrokerData } from "../broker.js";
import { AppError } from "../errors.js";
import {
  createFakeBrokerPurgeRepository,
  createInMemoryBrokerRepository,
  createInMemoryMediaStorage,
} from "../testing/index.js";
import {
  PURGE_PENDING_SHOWN,
  type PurgeStorageFailure,
  purgeBroker,
  purgeBrokerSummary,
} from "./purge-broker.js";

// F9.5-T14 (ADR-0035): borrar un corredor. Lo que borra la base lo prueba el repositorio con PGlite
// (`packages/db/test/broker-purge.test.ts`); aquí, las reglas: quién, la confirmación, los rechazos
// y que R2 va después del commit sin revertir la base.

const admin = { role: "admin" as const, brokerId: null };

const brokerData = (slug: string): BrokerData => ({
  slug,
  name: `Persona ${slug}`,
  brandName: `Marca ${slug}`,
  primaryColor: "#112233",
  secondaryColor: "#112233",
  whatsapp: null,
  email: null,
  instagramHandle: null,
  website: null,
  tone: null,
  fixedHashtags: [],
});

const bytes = new Uint8Array([1, 2, 3]);

async function setup() {
  const brokers = createInMemoryBrokerRepository();
  const broker = await brokers.create(brokerData("prueba"));
  const other = await brokers.create(brokerData("otro"));
  const brokerPurge = createFakeBrokerPurgeRepository();
  const storage = createInMemoryMediaStorage();
  const failures: PurgeStorageFailure[] = [];
  return {
    brokers,
    broker,
    other,
    brokerPurge,
    storage,
    failures,
    deps: {
      brokers,
      brokerPurge,
      storage,
      onStorageFailure: (failure: PurgeStorageFailure) => failures.push(failure),
    },
  };
}

describe("purgeBrokerSummary", () => {
  it("devuelve las cifras y lo que impide borrar, sin cambiar nada", async () => {
    const s = await setup();
    s.brokerPurge.set(s.broker.id, {
      counts: { listings: 3, media: 40, users: 1 },
      blocking: [{ publicationId: "p1", status: "scheduled", platform: "instagram" }],
    });
    const summary = await purgeBrokerSummary(s.deps, admin, s.broker.id);
    expect(summary.broker).toEqual({
      id: s.broker.id,
      slug: "prueba",
      brandName: "Marca prueba",
      kind: "broker",
    });
    expect(summary.counts).toMatchObject({ listings: 3, media: 40, users: 1, posts: 0 });
    expect(summary.blocking).toHaveLength(1);
    expect(s.brokerPurge.calls).toEqual([`summarize:${s.broker.id}`]);
  });

  it("solo el administrador; un corredor que no existe es BROKER_NOT_FOUND", async () => {
    const s = await setup();
    await expect(
      purgeBrokerSummary(s.deps, { role: "broker", brokerId: s.broker.id }, s.broker.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(purgeBrokerSummary(s.deps, admin, "no-existe")).rejects.toMatchObject({
      code: "BROKER_NOT_FOUND",
    });
  });
});

describe("purgeBroker", () => {
  it("borra la base y después los archivos de R2 por sus claves y prefijos", async () => {
    const s = await setup();
    const own = [
      `brokers/${s.broker.id}/listings/l1/original/a.jpg`,
      `brokers/${s.broker.id}/listings/l1/processed/ig_4x5/a-v1.jpg`,
      `brokers/${s.broker.id}/brand/logo.png`,
      "posts/post-1/original/b.jpg",
      "imports/run-1/planilla.xlsx",
    ];
    // Un logo anterior que la base ya no nombra: lo encuentra el prefijo del corredor.
    const orphan = `brokers/${s.broker.id}/brand/viejo.png`;
    const others = [`brokers/${s.other.id}/brand/logo.png`, "posts/post-2/original/c.jpg"];
    for (const key of [...own, orphan, ...others]) await s.storage.put(key, bytes, "image/jpeg");
    s.brokerPurge.set(s.broker.id, {
      refs: {
        mediaKeys: own.slice(0, 3),
        uploadKeys: ["posts/post-1/original/b.jpg", "posts/post-1/original/nunca-llego.jpg"],
        postIds: ["post-1"],
        importRunIds: ["run-1"],
      },
      deleted: { brokers: 1, listings: 1, media: 3 },
    });
    // R2 se toca solo después del commit.
    const deleteBeforePurge: string[] = [];
    const storage = {
      list: s.storage.list,
      delete: async (key: string) => {
        if (s.brokerPurge.purged.length === 0) deleteBeforePurge.push(key);
        await s.storage.delete(key);
      },
    };

    const result = await purgeBroker({ ...s.deps, storage }, admin, {
      brokerId: s.broker.id,
      confirm: "prueba",
    });

    expect(deleteBeforePurge).toEqual([]);
    expect(s.brokerPurge.calls).toEqual([
      `summarize:${s.broker.id}`,
      `storageRefs:${s.broker.id}`,
      `purge:${s.broker.id}`,
    ]);
    expect(result.broker).toEqual({ id: s.broker.id, slug: "prueba" });
    expect(result.deleted).toEqual({ brokers: 1, listings: 1, media: 3 });
    // Lo suyo (y la subida que nunca llegó, que no falla) se borró; lo de otros, no.
    expect([...s.storage.objects.keys()].sort()).toEqual([...others].sort());
    expect(result.storage).toEqual({ deleted: own.length + 2, pendingCount: 0, pending: [] });
    expect(s.failures).toEqual([]);
  });

  it("exige el slug exacto como confirmación, sin borrar nada", async () => {
    const s = await setup();
    for (const confirm of ["", "otro", "PRUEBA", "prueb"]) {
      await expect(
        purgeBroker(s.deps, admin, { brokerId: s.broker.id, confirm }),
      ).rejects.toMatchObject({ code: "BROKER_DELETE_NOT_CONFIRMED" });
    }
    expect(s.brokerPurge.calls).toEqual([]);
    // Los espacios alrededor se perdonan.
    await purgeBroker(s.deps, admin, { brokerId: s.broker.id, confirm: " prueba " });
    expect(s.brokerPurge.purged).toEqual([s.broker.id]);
  });

  it("solo el administrador, ni siquiera el corredor con lo suyo", async () => {
    const s = await setup();
    await expect(
      purgeBroker(
        s.deps,
        { role: "broker", brokerId: s.broker.id },
        { brokerId: s.broker.id, confirm: "prueba" },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(s.brokerPurge.calls).toEqual([]);
  });

  it.each(["publishing", "scheduled", "awaiting_manual_confirm", "outcome_unknown"] as const)(
    "se niega con una publicación %s, sin tocar la base ni R2",
    async (status) => {
      const s = await setup();
      const key = `brokers/${s.broker.id}/brand/logo.png`;
      await s.storage.put(key, bytes, "image/png");
      s.brokerPurge.set(s.broker.id, {
        blocking: [{ publicationId: "pub-1", status, platform: "instagram" }],
        refs: { mediaKeys: [key] },
      });
      const error = await purgeBroker(s.deps, admin, {
        brokerId: s.broker.id,
        confirm: "prueba",
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: "BROKER_HAS_ACTIVE_PUBLICATIONS",
        details: { publicationIds: ["pub-1"] },
      });
      expect((error as AppError).message).toMatch(/desprograma|resuelve/);
      expect(s.brokerPurge.purged).toEqual([]);
      expect(s.storage.objects.has(key)).toBe(true);
    },
  );

  it("si la base falla, R2 queda intacto", async () => {
    const s = await setup();
    const key = `brokers/${s.broker.id}/brand/logo.png`;
    await s.storage.put(key, bytes, "image/png");
    s.brokerPurge.set(s.broker.id, {
      refs: { mediaKeys: [key] },
      failPurge: new AppError("DB_UNAVAILABLE", "la base no responde", { retriable: true }),
    });
    await expect(
      purgeBroker(s.deps, admin, { brokerId: s.broker.id, confirm: "prueba" }),
    ).rejects.toMatchObject({ code: "DB_UNAVAILABLE" });
    expect(s.storage.objects.has(key)).toBe(true);
  });

  it("un fallo de R2 no revierte la base: queda anotado con su clave, sin URLs", async () => {
    const s = await setup();
    const keys = Array.from(
      { length: 40 },
      (_, i) => `brokers/${s.broker.id}/listings/l1/original/${String(i).padStart(2, "0")}.jpg`,
    );
    for (const key of keys) await s.storage.put(key, bytes, "image/jpeg");
    s.brokerPurge.set(s.broker.id, { refs: { mediaKeys: keys, postIds: ["post-9"] } });
    const failing = new Set([keys[3], keys[20]]);
    const storage = {
      list: async (prefix: string) => {
        if (prefix === "posts/post-9/") {
          throw new AppError("STORAGE_UNAVAILABLE", "R2 no respondió", { retriable: true });
        }
        return s.storage.list(prefix);
      },
      delete: async (key: string) => {
        if (failing.has(key)) throw new AppError("STORAGE_ERROR", "R2 rechazó (403)");
        await s.storage.delete(key);
      },
    };

    const result = await purgeBroker({ ...s.deps, storage }, admin, {
      brokerId: s.broker.id,
      confirm: "prueba",
    });

    expect(s.brokerPurge.purged).toEqual([s.broker.id]);
    expect(result.storage.deleted).toBe(38);
    expect(result.storage.pendingCount).toBe(3);
    expect(result.storage.pending).toEqual([
      { kind: "prefix", prefix: "posts/post-9/", code: "STORAGE_UNAVAILABLE" },
      { kind: "key", key: keys[3], code: "STORAGE_ERROR" },
      { kind: "key", key: keys[20], code: "STORAGE_ERROR" },
    ]);
    expect(s.failures).toEqual(result.storage.pending);
    expect(JSON.stringify(result)).not.toMatch(/https?:|memory:\/\//);
    expect([...s.storage.objects.keys()].sort()).toEqual([keys[3], keys[20]].sort());
  });

  it("la respuesta trae a lo más PURGE_PENDING_SHOWN pendientes; el aviso, todos", async () => {
    const s = await setup();
    const keys = Array.from({ length: PURGE_PENDING_SHOWN + 5 }, (_, i) => `brokers/x/${i}.jpg`);
    s.brokerPurge.set(s.broker.id, { refs: { mediaKeys: keys } });
    const storage = {
      list: async () => [],
      delete: async () => {
        throw new AppError("STORAGE_UNAVAILABLE", "R2 no respondió", { retriable: true });
      },
    };
    const result = await purgeBroker({ ...s.deps, storage }, admin, {
      brokerId: s.broker.id,
      confirm: "prueba",
    });
    expect(result.storage.pendingCount).toBe(keys.length);
    expect(result.storage.pending).toHaveLength(PURGE_PENDING_SHOWN);
    expect(s.failures).toHaveLength(keys.length);
  });
});
