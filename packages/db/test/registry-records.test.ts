import type { RegistryRepository } from "@agentsales/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistryRepository } from "../src/repositories/registry-records.js";
import { brokers, listings, registryRecords, users } from "../src/schema.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";

// F12-T07 (ADR-0039): el registro de una propiedad sobre PGlite con la migración 0022.

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

describe("RegistryRepository (Drizzle sobre PGlite)", () => {
  let testDb: TestDatabase;
  let registry: RegistryRepository;
  let brokerId: string;
  let userId: string;

  const newListing = async (ref: string): Promise<string> => {
    const [row] = await testDb.db
      .insert(listings)
      .values({
        brokerId,
        externalRef: ref,
        category: "inmueble",
        priceAmount: "5800",
        priceCurrency: "UF",
        source: "xlsx",
        sourceHash: "hash",
        attributes: {},
      })
      .returning();
    return row?.id ?? "";
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    registry = createRegistryRepository(testDb.db);
    const [broker] = await testDb.db
      .insert(brokers)
      .values({
        slug: "vinny",
        name: "Vinny",
        brandName: "Vinny",
        primaryColor: "#123456",
        secondaryColor: "#abcdef",
      })
      .returning();
    brokerId = broker?.id ?? "";
    const [user] = await testDb.db
      .insert(users)
      .values({ email: "admin@ejemplo.cl", name: "Admin", role: "admin" })
      .returning();
    userId = user?.id ?? "";
  });
  afterAll(async () => {
    await testDb.close();
  });

  it("crea un borrador y lo aprueba solo con el hash que se revisó", async () => {
    const listingId = await newListing("R-1");
    expect(await registry.get(listingId)).toBeNull();
    const draft = await registry.upsert({
      listingId,
      brokerId,
      payload: { a: 1 },
      contentHash: H1,
    });
    expect(draft).toMatchObject({ status: "draft", contentHash: H1, approvedAt: null });

    expect(await registry.approve(listingId, userId, H2)).toBeNull();
    const approved = await registry.approve(listingId, userId, H1);
    expect(approved).toMatchObject({ status: "approved", approvedBy: userId });
    expect(approved?.approvedAt).toBeInstanceOf(Date);
    // Ya aprobado: aprobar otra vez no hace nada.
    expect(await registry.approve(listingId, userId, H1)).toBeNull();
  });

  it("si el contenido no cambia no toca nada; si cambia vuelve a borrador sin aprobación", async () => {
    const listingId = await newListing("R-2");
    await registry.upsert({ listingId, brokerId, payload: { v: 1 }, contentHash: H1 });
    await registry.approve(listingId, userId, H1);

    const same = await registry.upsert({
      listingId,
      brokerId,
      payload: { v: "ignorado" },
      contentHash: H1,
    });
    expect(same).toMatchObject({ status: "approved", payload: { v: 1 } });

    const changed = await registry.upsert({
      listingId,
      brokerId,
      payload: { v: 2 },
      contentHash: H2,
    });
    expect(changed).toMatchObject({
      status: "draft",
      payload: { v: 2 },
      contentHash: H2,
      approvedAt: null,
      approvedBy: null,
    });
    expect((await registry.withdraw(listingId))?.status).toBe("withdrawn");
    const [row] = await testDb.db
      .select()
      .from(registryRecords)
      .where(eq(registryRecords.listingId, listingId));
    expect(row?.status).toBe("withdrawn");
    expect(await registry.withdraw("00000000-0000-4000-8000-0000000000aa")).toBeNull();
  });

  it("una propiedad que no existe es REGISTRY_REFERENCE_INVALID", async () => {
    await expect(
      registry.upsert({
        listingId: "00000000-0000-4000-8000-0000000000ff",
        brokerId,
        payload: {},
        contentHash: H1,
      }),
    ).rejects.toMatchObject({ code: "REGISTRY_REFERENCE_INVALID" });
  });
});
