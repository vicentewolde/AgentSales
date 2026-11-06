import { z } from "zod";
import type { NewLeadInput } from "../leads.js";

// El «External Request» de ManyChat (F10-T04, ADR-0033). El cuerpo lo definimos nosotros en el flujo
// de ManyChat (campos de «Full contact data» más los que se agregan): la forma exacta que envía el
// producto real NO está verificada, por eso el lector acepta solo lo que nombra y todo es opcional
// salvo el id del suscriptor y el consentimiento, que `receiveLead` exige.

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === undefined || v === null || v === "" ? null : v));

export const manychatPayloadSchema = z.object({
  /** El id del suscriptor en ManyChat: con el corredor, hace idempotente el lead. */
  subscriber_id: z.coerce.string().trim().min(1).max(200),
  name: text(200),
  first_name: text(100),
  last_name: text(100),
  phone: text(40),
  email: text(200),
  /** El id de la propiedad en AgentSales (va en el `ref` o la etiqueta de la campaña). */
  listing_id: z.string().uuid().nullish(),
  ad_id: text(100),
  campaign: text(200),
  /** `true` solo si la persona aceptó que la contacten. Cualquier otra cosa es «no». */
  consent: z.unknown().optional(),
  consent_text: text(500),
  consent_at: z.coerce.date().optional(),
});
export type ManychatPayload = z.infer<typeof manychatPayloadSchema>;

/** Lo que `receiveLead` necesita, a partir del cuerpo de ManyChat y el corredor de la ruta. */
export function manychatToLead(
  brokerId: string,
  payload: ManychatPayload,
  now: Date,
): NewLeadInput {
  const full = [payload.first_name, payload.last_name].filter((p) => p !== null).join(" ");
  return {
    brokerId,
    source: "manychat",
    externalId: payload.subscriber_id,
    listingId: payload.listing_id ?? null,
    adId: payload.ad_id,
    campaign: payload.campaign,
    name: payload.name ?? (full === "" ? null : full),
    phone: payload.phone,
    email: payload.email,
    // `given` va como llegó: si no es `true`, `receiveLead` responde LEAD_CONSENT_REQUIRED.
    consent: {
      given: payload.consent === true || payload.consent === "true",
      text: payload.consent_text,
      at: payload.consent_at ?? now,
    } as NewLeadInput["consent"],
  };
}
