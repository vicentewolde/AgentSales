import type { Listing, RegistryRecord, RegistryRepository } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { buildPayload, payloadHash } from "../src/record/from-listing.js";
import { approveRegistry, buildRegistry } from "../src/record/use-cases.js";

const listing = (over: Partial<Listing> = {}): Listing => ({
  id: "L1",
  brokerId: "B1",
  externalRef: "R-1",
  category: "real_estate",
  status: "ready",
  closeReason: null,
  operation: "sale",
  propertyType: "Departamento",
  region: "RM",
  comuna: "Providencia",
  address: "Av. Siempre Viva 742",
  unitNumber: null,
  showExactAddress: false,
  priceAmount: 5800,
  priceCurrency: "UF",
  highlights: null,
  internalNotes: "mínimo UF 5.200",
  attributes: {
    dormitorios: 3,
    banos: 2,
    sup_util_m2: 82.5,
    acepta_mascotas: true,
    amenities: ["Piscina", " Gimnasio "],
  },
  source: "xlsx",
  musicTrackId: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-02T00:00:00Z"),
  ...over,
});

function memoryRegistry(): RegistryRepository & { rows: Map<string, RegistryRecord> } {
  const rows = new Map<string, RegistryRecord>();
  return {
    rows,
    async get(id) {
      return rows.get(id) ?? null;
    },
    async upsert(i) {
      const old = rows.get(i.listingId);
      if (old && old.contentHash === i.contentHash) return old;
      const now = new Date();
      const row: RegistryRecord = {
        id: `reg-${i.listingId}`,
        listingId: i.listingId,
        brokerId: i.brokerId,
        status: "draft",
        payload: i.payload,
        contentHash: i.contentHash,
        approvedAt: null,
        approvedBy: null,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
      };
      rows.set(i.listingId, row);
      return row;
    },
    async approve(id, userId, hash) {
      const r = rows.get(id);
      if (!r || r.status !== "draft" || r.contentHash !== hash) return null;
      const next = {
        ...r,
        status: "approved" as const,
        approvedBy: userId,
        approvedAt: new Date(),
      };
      rows.set(id, next);
      return next;
    },
    async withdraw(id) {
      const r = rows.get(id);
      if (!r) return null;
      const next = { ...r, status: "withdrawn" as const };
      rows.set(id, next);
      return next;
    },
  };
}

describe("registro desde una propiedad de AgentSales", () => {
  it("todo lo que declara el corredor es broker_declared y nunca sale lo interno", () => {
    const p = buildPayload(listing());
    expect(p.declared).toMatchObject({
      commune: "Providencia",
      bedrooms: 3,
      bathrooms: 2,
      area_m2: 82.5,
      pets_allowed: true,
    });
    expect(p.policy.showExactAddress).toBe(false);
    expect(p.claims.every((c) => c.provenance === "broker_declared")).toBe(true);
    expect(p.claims.map((c) => c.statement)).toEqual(
      expect.arrayContaining(["Piscina", "Gimnasio"]),
    );
    expect(JSON.stringify(p)).not.toContain("5.200");
  });

  it("el hash es estable y cambia solo si cambia lo declarado", () => {
    const a = payloadHash(buildPayload(listing()));
    expect(payloadHash(buildPayload(listing()))).toBe(a);
    expect(payloadHash(buildPayload(listing({ priceAmount: 5700 })))).not.toBe(a);
    expect(payloadHash(buildPayload(listing({ internalNotes: "otra nota" })))).toBe(a);
  });

  it("construye, aprueba y, si el corredor cambia el precio, vuelve a borrador", async () => {
    const registry = memoryRegistry();
    let current = listing();
    const deps = { listings: { get: async () => current }, registry };

    const draft = await buildRegistry(deps, "L1");
    expect(draft.status).toBe("draft");
    expect((await approveRegistry(deps, "L1", "U1")).status).toBe("approved");
    expect((await buildRegistry(deps, "L1")).status).toBe("approved");

    current = listing({ priceAmount: 5500, updatedAt: new Date("2026-10-05T00:00:00Z") });
    expect((await buildRegistry(deps, "L1")).status).toBe("draft");
  });

  it("errores: propiedad inexistente, sin registro, ya aprobado o con el contenido alterado", async () => {
    const registry = memoryRegistry();
    const deps = {
      listings: { get: async (id: string) => (id === "L1" ? listing() : null) },
      registry,
    };
    await expect(buildRegistry(deps, "X")).rejects.toMatchObject({ code: "LISTING_NOT_FOUND" });
    await expect(approveRegistry(deps, "L1", "U1")).rejects.toMatchObject({
      code: "REGISTRY_NOT_FOUND",
    });
    await buildRegistry(deps, "L1");
    await approveRegistry(deps, "L1", "U1");
    await expect(approveRegistry(deps, "L1", "U1")).rejects.toMatchObject({
      code: "REGISTRY_NOT_APPROVABLE",
    });

    const row = registry.rows.get("L1");
    if (row)
      registry.rows.set("L1", {
        ...row,
        status: "draft",
        payload: { ...(row.payload as object), claims: [] },
      });
    await expect(approveRegistry(deps, "L1", "U1")).rejects.toMatchObject({
      code: "REGISTRY_ROW_INVALID",
    });
  });
});
