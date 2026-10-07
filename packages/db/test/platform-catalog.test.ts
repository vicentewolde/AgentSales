import type { PlatformCatalogEntry, PlatformCatalogRepository } from "@agentsales/core";
import { createInMemoryPlatformCatalogRepository } from "@agentsales/core/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlatformCatalogRepository } from "../src/repositories/platform-catalog.js";
import { platformCatalog } from "../src/schema.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";

const FETCHED_AT = new Date("2026-10-07T12:00:00Z");

const entry = (overrides: Partial<PlatformCatalogEntry> = {}): PlatformCatalogEntry => ({
  platform: "portal_inmobiliario",
  key: "category:MLC1459",
  data: {
    id: "MLC1459",
    name: "Inmuebles",
    childrenCategories: [],
    settings: { listingAllowed: null },
  },
  fetchedAt: FETCHED_AT,
  ...overrides,
});

/**
 * Suite de contrato de `PlatformCatalogRepository` (F4-T09): igual contra el doble en memoria y
 * contra Drizzle sobre PGlite.
 */
function platformCatalogContract(name: string, make: () => Promise<PlatformCatalogRepository>) {
  describe(`${name} · PlatformCatalogRepository`, () => {
    let repository: PlatformCatalogRepository;
    beforeAll(async () => {
      repository = await make();
    });

    it("guarda y lee una entrada; una que no está es null", async () => {
      await repository.put(entry());

      expect(await repository.get("portal_inmobiliario", "category:MLC1459")).toEqual(entry());
      expect(await repository.get("portal_inmobiliario", "category:MLC0")).toBeNull();
      expect(await repository.get("instagram", "category:MLC1459")).toBeNull();
    });

    it("guardar la misma clave reemplaza los datos y la fecha", async () => {
      const key = "location:CL";
      await repository.put(entry({ key, data: { version: 1 } }));
      const later = new Date("2026-10-15T12:00:00Z");
      await repository.put(entry({ key, data: { version: 2, children: ["a"] }, fetchedAt: later }));

      expect(await repository.get("portal_inmobiliario", key)).toEqual(
        entry({ key, data: { version: 2, children: ["a"] }, fetchedAt: later }),
      );
    });

    it("lo leído es una copia: cambiarlo no cambia lo guardado", async () => {
      const key = "attributes:MLC1480";
      await repository.put(entry({ key, data: { list: [1, 2] } }));
      const read = await repository.get("portal_inmobiliario", key);
      expect(read).not.toBeNull();
      (read as PlatformCatalogEntry & { data: { list: number[] } }).data.list.push(3);

      expect((await repository.get("portal_inmobiliario", key))?.data).toEqual({ list: [1, 2] });
    });

    it("una clave sin la forma tipo:id no se guarda (PLATFORM_CATALOG_ROW_INVALID)", async () => {
      await expect(repository.put(entry({ key: "MLC1459" }))).rejects.toMatchObject({
        code: "PLATFORM_CATALOG_ROW_INVALID",
        retriable: false,
      });
      expect(await repository.get("portal_inmobiliario", "MLC1459")).toBeNull();
    });
  });
}

const databases: TestDatabase[] = [];
afterAll(async () => {
  await Promise.all(databases.map((database) => database.close()));
});

async function pglite() {
  const database = await createTestDatabase();
  databases.push(database);
  return database;
}

platformCatalogContract("en memoria", async () => createInMemoryPlatformCatalogRepository());
platformCatalogContract("Drizzle sobre PGlite", async () =>
  createPlatformCatalogRepository((await pglite()).db),
);

describe("Drizzle · platform_catalog", () => {
  it("guarda data como JSON y actualiza updated_at al reemplazar", async () => {
    const { db } = await pglite();
    const repository = createPlatformCatalogRepository(db);
    const key = "category:MLC1472";
    const where = and(
      eq(platformCatalog.platform, "portal_inmobiliario"),
      eq(platformCatalog.key, key),
    );
    await repository.put(entry({ key }));
    const [first] = await db.select().from(platformCatalog).where(where);
    // `now()` es la hora de la transacción: se espera un poco para que avance.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await repository.put(entry({ key, data: { otra: true } }));
    const [second] = await db.select().from(platformCatalog).where(where);

    expect(first?.data).toEqual(entry().data);
    expect(second?.data).toEqual({ otra: true });
    expect(second?.createdAt).toEqual(first?.createdAt);
    expect(second?.updatedAt.getTime()).toBeGreaterThan(first?.updatedAt.getTime() ?? 0);
  });
});
