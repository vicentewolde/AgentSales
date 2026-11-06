import { describe, expect, it } from "vitest";
import { receiveLead } from "../leads.js";
import { createInMemoryLeadRepository } from "../testing/leads.js";
import { manychatPayloadSchema, manychatToLead } from "./manychat.js";

const NOW = new Date("2026-11-06T12:00:00Z");
const LISTING = "11111111-1111-4111-8111-111111111111";

const deps = () => ({
  leads: createInMemoryLeadRepository(),
  listings: {
    get: async (id: string) => (id === LISTING ? ({ id, brokerId: "B1" } as never) : null),
  },
});

describe("manychatToLead", () => {
  it("arma el lead con el nombre, la atribución y el consentimiento", async () => {
    const payload = manychatPayloadSchema.parse({
      subscriber_id: 12345,
      first_name: "Ana",
      last_name: "Pérez",
      phone: "+56911112222",
      listing_id: LISTING,
      ad_id: "ad-9",
      consent: true,
      consent_text: "Acepto que me contacten",
    });
    const { lead, created } = await receiveLead(deps(), manychatToLead("B1", payload, NOW));
    expect(created).toBe(true);
    expect(lead).toMatchObject({
      source: "manychat",
      externalId: "12345",
      name: "Ana Pérez",
      adId: "ad-9",
      listingId: LISTING,
    });
    expect(lead.consent.at).toEqual(NOW);
  });

  it("sin consentimiento verdadero no se guarda (también con texto «false»)", async () => {
    for (const consent of [undefined, false, "no", "false", 1]) {
      const payload = manychatPayloadSchema.parse({
        subscriber_id: "x",
        phone: "+56911112222",
        consent,
      });
      await expect(receiveLead(deps(), manychatToLead("B1", payload, NOW))).rejects.toMatchObject({
        code: "LEAD_CONSENT_REQUIRED",
      });
    }
  });

  it("acepta el consentimiento como texto «true»", async () => {
    const payload = manychatPayloadSchema.parse({
      subscriber_id: "x",
      email: "ANA@Correo.cl",
      consent: "true",
    });
    const { lead } = await receiveLead(deps(), manychatToLead("B1", payload, NOW));
    expect(lead.email).toBe("ana@correo.cl");
  });

  it("sin teléfono ni correo no se guarda", async () => {
    const payload = manychatPayloadSchema.parse({ subscriber_id: "x", consent: true });
    await expect(receiveLead(deps(), manychatToLead("B1", payload, NOW))).rejects.toMatchObject({
      code: "LEAD_INVALID",
    });
  });

  it("una propiedad de otro corredor se rechaza", async () => {
    const payload = manychatPayloadSchema.parse({
      subscriber_id: "x",
      phone: "+56911112222",
      listing_id: LISTING,
      consent: true,
    });
    await expect(receiveLead(deps(), manychatToLead("B2", payload, NOW))).rejects.toMatchObject({
      code: "LEAD_LISTING_INVALID",
    });
  });

  it("el mismo suscriptor enviado dos veces queda una vez", async () => {
    const d = deps();
    const payload = manychatPayloadSchema.parse({
      subscriber_id: "7",
      phone: "+56911112222",
      consent: true,
    });
    await receiveLead(d, manychatToLead("B1", payload, NOW));
    const again = await receiveLead(d, manychatToLead("B1", payload, NOW));
    expect(again.created).toBe(false);
  });

  it("rechaza un cuerpo sin id de suscriptor o con un id de propiedad que no es uuid", () => {
    expect(manychatPayloadSchema.safeParse({ consent: true }).success).toBe(false);
    expect(
      manychatPayloadSchema.safeParse({ subscriber_id: "1", listing_id: "no-es-uuid" }).success,
    ).toBe(false);
  });
});
