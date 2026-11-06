import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLeadWebhookKeyRepository } from "../src/repositories/lead-webhook-keys.js";
import { brokers } from "../src/schema.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";

// F10-T04 (ADR-0033): el hash del secreto del webhook de cada corredor, con la migración 0024.

describe("LeadWebhookKeyRepository (Drizzle sobre PGlite)", () => {
  let testDb: TestDatabase;
  let brokerId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    const [b] = await testDb.db
      .insert(brokers)
      .values({
        slug: "vinny",
        name: "Vinny",
        brandName: "Vinny",
        primaryColor: "#123456",
        secondaryColor: "#abcdef",
      })
      .returning();
    brokerId = b?.id ?? "";
  });
  afterAll(async () => {
    await testDb.close();
  });

  it("sin secreto da null, guarda el hash y al rotar lo reemplaza", async () => {
    const repo = createLeadWebhookKeyRepository(testDb.db);
    expect(await repo.getHash(brokerId)).toBeNull();
    await repo.setHash(brokerId, "a".repeat(64));
    expect(await repo.getHash(brokerId)).toBe("a".repeat(64));
    await repo.setHash(brokerId, "b".repeat(64));
    expect(await repo.getHash(brokerId)).toBe("b".repeat(64));
  });
});
