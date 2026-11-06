import { describe, expect, it } from "vitest";
import {
  changeLeadStatus,
  csvCell,
  eraseLead,
  type Lead,
  type LeadDeps,
  leadsToCsv,
  receiveLead,
} from "./leads.js";
import type { LeadRepository } from "./ports/lead-repository.js";

function memoryLeads(): LeadRepository {
  const rows = new Map<string, Lead>();
  let n = 0;
  return {
    async create(input) {
      const dup = [...rows.values()].find(
        (l) =>
          l.brokerId === input.brokerId &&
          l.source === input.source &&
          l.externalId === input.externalId,
      );
      if (dup) return { lead: dup, created: false };
      const now = new Date();
      const lead: Lead = {
        id: `lead-${++n}`,
        brokerId: input.brokerId,
        source: input.source,
        externalId: input.externalId,
        listingId: input.listingId,
        adId: input.adId,
        campaign: input.campaign,
        name: input.name,
        phone: input.phone,
        email: input.email,
        consent: input.consent,
        status: "new",
        assignedTo: null,
        erasedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(lead.id, lead);
      return { lead, created: true };
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async list() {
      return [...rows.values()];
    },
    async setStatus(id, from, to) {
      const l = rows.get(id);
      if (!l || l.status !== from) return null;
      const next = { ...l, status: to };
      rows.set(id, next);
      return next;
    },
    async assign(id, userId) {
      const l = rows.get(id);
      if (!l) return null;
      const next = { ...l, assignedTo: userId };
      rows.set(id, next);
      return next;
    },
    async erase(id) {
      const l = rows.get(id);
      if (!l) return null;
      const next = { ...l, name: null, phone: null, email: null, erasedAt: new Date() };
      rows.set(id, next);
      return next;
    },
  };
}

const CONSENT = {
  given: true as const,
  text: "Acepto que me contacten",
  at: new Date("2026-11-06T12:00:00Z"),
};

const setup = () => {
  const deps: LeadDeps = {
    leads: memoryLeads(),
    listings: { get: async (id) => (id === "L1" ? ({ id, brokerId: "B1" } as never) : null) },
  };
  return deps;
};

const base = {
  brokerId: "B1",
  source: "manychat" as const,
  externalId: "mc-1",
  phone: "+56911112222",
  consent: CONSENT,
};

describe("receiveLead", () => {
  it("guarda un lead con consentimiento y no lo duplica", async () => {
    const deps = setup();
    const a = await receiveLead(deps, {
      ...base,
      listingId: "L1",
      adId: "ad-9",
      email: " Ana@Ejemplo.CL ",
    });
    expect(a.created).toBe(true);
    expect(a.lead).toMatchObject({
      status: "new",
      listingId: "L1",
      adId: "ad-9",
      email: "ana@ejemplo.cl",
    });
    const b = await receiveLead(deps, { ...base });
    expect(b).toMatchObject({ created: false, lead: { id: a.lead.id } });
  });

  it("sin consentimiento, sin contacto o con propiedad ajena no guarda nada", async () => {
    const deps = setup();
    await expect(
      receiveLead(deps, { ...base, consent: { ...CONSENT, given: false } as never }),
    ).rejects.toMatchObject({ code: "LEAD_CONSENT_REQUIRED" });
    await expect(receiveLead(deps, { ...base, phone: null })).rejects.toMatchObject({
      code: "LEAD_INVALID",
    });
    await expect(receiveLead(deps, { ...base, listingId: "otra" })).rejects.toMatchObject({
      code: "LEAD_LISTING_INVALID",
    });
    await expect(
      receiveLead(
        { ...deps, listings: { get: async () => ({ id: "L1", brokerId: "B2" }) as never } },
        { ...base, listingId: "L1" },
      ),
    ).rejects.toMatchObject({ code: "LEAD_LISTING_INVALID" });
    expect(await deps.leads.list({ brokerId: "B1" }, 10)).toHaveLength(0);
  });
});

describe("estado y borrado", () => {
  it("solo avanza por las transiciones permitidas", async () => {
    const deps = setup();
    const { lead } = await receiveLead(deps, base);
    await expect(changeLeadStatus(deps, lead.id, "won")).rejects.toMatchObject({
      code: "LEAD_TRANSITION_INVALID",
    });
    expect((await changeLeadStatus(deps, lead.id, "contacted")).status).toBe("contacted");
    expect((await changeLeadStatus(deps, lead.id, "won")).status).toBe("won");
    await expect(changeLeadStatus(deps, lead.id, "lost")).rejects.toMatchObject({
      code: "LEAD_TRANSITION_INVALID",
    });
    await expect(changeLeadStatus(deps, "nada", "lost")).rejects.toMatchObject({
      code: "LEAD_NOT_FOUND",
    });
  });

  it("borrar quita los datos personales, conserva la atribución y bloquea cambios", async () => {
    const deps = setup();
    const { lead } = await receiveLead(deps, { ...base, listingId: "L1", name: "Ana" });
    const erased = await eraseLead(deps, lead.id);
    expect(erased).toMatchObject({ name: null, phone: null, email: null, listingId: "L1" });
    expect(erased.erasedAt).toBeInstanceOf(Date);
    await expect(changeLeadStatus(deps, lead.id, "contacted")).rejects.toMatchObject({
      code: "LEAD_ERASED",
    });
    await expect(eraseLead(deps, "nada")).rejects.toMatchObject({ code: "LEAD_NOT_FOUND" });
  });
});

describe("CSV", () => {
  it("escapa comillas y evita fórmulas de planilla", () => {
    expect(csvCell('di "hola", ya')).toBe('"di ""hola"", ya"');
    expect(csvCell("=CMD()")).toBe("'=CMD()");
    expect(csvCell("+56911112222")).toBe("'+56911112222");
    expect(csvCell(null)).toBe("");
  });

  it("los borrados salen sin datos personales", async () => {
    const deps = setup();
    const { lead } = await receiveLead(deps, { ...base, name: "=HYPERLINK(x)" });
    const csv = leadsToCsv([lead, await eraseLead(deps, lead.id)]);
    expect(csv.split("\n")).toHaveLength(3);
    expect(csv).toContain("'=HYPERLINK(x)");
    expect(csv.split("\n")[2]).not.toContain("56911112222");
  });
});
