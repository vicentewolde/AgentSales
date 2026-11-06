import { createFakeSecretBox } from "@agentsales/core/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLeadRepository } from "../src/repositories/leads.js";
import { brokers, leadEvents, leads, listings } from "../src/schema.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";

// F10-T01 (ADR-0033): leads cifrados, idempotentes y borrables, sobre PGlite con la migración 0023.

const CONSENT = { given: true as const, text: "Acepto", at: new Date("2026-11-06T12:00:00Z") };

describe("LeadRepository (Drizzle sobre PGlite)", () => {
  let testDb: TestDatabase;
  let brokerId: string;
  let listingId: string;
  const repo = () => createLeadRepository(testDb.db, createFakeSecretBox());
  const input = (externalId: string) => ({
    brokerId,
    source: "manychat" as const,
    externalId,
    listingId,
    adId: "ad-1",
    campaign: "camp",
    name: "Ana Pérez",
    phone: "+56911112222",
    email: "ana@ejemplo.cl",
    consent: CONSENT,
  });

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
    const [l] = await testDb.db
      .insert(listings)
      .values({
        brokerId,
        externalRef: "R-1",
        category: "real_estate",
        priceAmount: "5800",
        priceCurrency: "UF",
        source: "xlsx",
        sourceHash: "h",
        attributes: {},
      })
      .returning();
    listingId = l?.id ?? "";
  });
  afterAll(async () => {
    await testDb.close();
  });

  it("guarda cifrado, devuelve en claro y no duplica el mismo lead de origen", async () => {
    const first = await repo().create(input("mc-1"));
    expect(first.created).toBe(true);
    expect(first.lead).toMatchObject({
      name: "Ana Pérez",
      phone: "+56911112222",
      status: "new",
      adId: "ad-1",
    });

    const [raw] = await testDb.db.select().from(leads).where(eq(leads.id, first.lead.id));
    expect(raw?.phoneEncrypted).not.toBe("+56911112222");
    expect(raw?.emailEncrypted).not.toBe("ana@ejemplo.cl");

    const again = await repo().create(input("mc-1"));
    expect(again).toMatchObject({ created: false, lead: { id: first.lead.id } });
    expect(await repo().list({ brokerId }, 50)).toHaveLength(1);
  });

  it("cambia de estado solo desde el esperado, asigna y lista con filtros", async () => {
    const { lead } = await repo().create(input("mc-2"));
    expect(await repo().setStatus(lead.id, "contacted", "won")).toBeNull();
    expect((await repo().setStatus(lead.id, "new", "contacted"))?.status).toBe("contacted");
    expect((await repo().assign(lead.id, null))?.assignedTo).toBeNull();
    const contacted = await repo().list({ brokerId, status: "contacted" }, 10);
    expect(contacted.map((l) => l.id)).toEqual([lead.id]);
    expect(
      await repo().list({ brokerId, listingId: "00000000-0000-4000-8000-0000000000aa" }, 10),
    ).toEqual([]);
    const events = await testDb.db.select().from(leadEvents).where(eq(leadEvents.leadId, lead.id));
    expect(events.map((e) => e.kind).sort()).toEqual(["assigned", "received", "status"]);
  });

  it("borrar deja nulos los datos personales (también en la base) y conserva la atribución", async () => {
    const { lead } = await repo().create(input("mc-3"));
    const erased = await repo().erase(lead.id);
    expect(erased).toMatchObject({ name: null, phone: null, email: null, adId: "ad-1", listingId });
    expect(erased?.erasedAt).toBeInstanceOf(Date);
    const [raw] = await testDb.db.select().from(leads).where(eq(leads.id, lead.id));
    expect([raw?.nameEncrypted, raw?.phoneEncrypted, raw?.emailEncrypted]).toEqual([
      null,
      null,
      null,
    ]);
    expect(await repo().erase("00000000-0000-4000-8000-0000000000aa")).toBeNull();
  });

  it("un corredor que no existe es LEAD_REFERENCE_INVALID", async () => {
    await expect(
      repo().create({ ...input("mc-9"), brokerId: "00000000-0000-4000-8000-0000000000ff" }),
    ).rejects.toMatchObject({ code: "LEAD_REFERENCE_INVALID" });
  });
});
