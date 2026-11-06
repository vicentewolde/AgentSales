import type { Lead } from "../leads.js";
import type { LeadRepository } from "../ports/lead-repository.js";
import type { LeadWebhookKeyRepository } from "../ports/lead-webhook-key-repository.js";

/** Un `LeadRepository` en memoria, con los mismos filtros y la misma idempotencia que el de Postgres. */
export function createInMemoryLeadRepository(): LeadRepository {
  const rows = new Map<string, Lead>();
  let n = 0;
  const put = (lead: Lead) => {
    rows.set(lead.id, lead);
    return lead;
  };
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
        id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
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
      return { lead: put(lead), created: true };
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async list(filters, limit) {
      return [...rows.values()]
        .filter(
          (l) =>
            l.brokerId === filters.brokerId &&
            (filters.status === undefined || l.status === filters.status) &&
            (filters.listingId === undefined || l.listingId === filters.listingId),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
    },
    async setStatus(id, from, to) {
      const l = rows.get(id);
      if (!l || l.status !== from) return null;
      return put({ ...l, status: to, updatedAt: new Date() });
    },
    async assign(id, userId) {
      const l = rows.get(id);
      if (!l) return null;
      return put({ ...l, assignedTo: userId, updatedAt: new Date() });
    },
    async erase(id) {
      const l = rows.get(id);
      if (!l) return null;
      return put({
        ...l,
        name: null,
        phone: null,
        email: null,
        erasedAt: l.erasedAt ?? new Date(),
        updatedAt: new Date(),
      });
    },
  };
}

export function createInMemoryLeadWebhookKeyRepository(): LeadWebhookKeyRepository {
  const hashes = new Map<string, string>();
  return {
    async getHash(brokerId) {
      return hashes.get(brokerId) ?? null;
    },
    async setHash(brokerId, secretHash) {
      hashes.set(brokerId, secretHash);
    },
  };
}
