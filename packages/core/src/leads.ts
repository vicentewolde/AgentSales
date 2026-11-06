import { z } from "zod";
import { AppError } from "./errors.js";
import type { LeadRepository } from "./ports/lead-repository.js";
import type { ListingRepository } from "./ports/listing-repository.js";

// Leads con atribución (F10, ADR-0033): datos personales de terceros. La corredora es la
// responsable y AgentSales la encargada; por eso hay consentimiento obligatorio, cifrado y borrado.

export const LEAD_SOURCES = ["manychat", "manual"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_STATUSES = ["new", "contacted", "visit_scheduled", "won", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const leadConsentSchema = z.object({
  /** Dijo que sí a que lo contacten. Sin esto el lead no se guarda. */
  given: z.literal(true),
  /** El texto que vio o aceptó (para poder probarlo). */
  text: z.string().max(500).nullable(),
  at: z.coerce.date(),
});
export type LeadConsent = z.infer<typeof leadConsentSchema>;

export const newLeadSchema = z
  .object({
    brokerId: z.string(),
    source: z.enum(LEAD_SOURCES),
    /** Id del lead en el origen: con el corredor y el origen, evita duplicados. */
    externalId: z.string().min(1).max(200),
    listingId: z.string().nullable().default(null),
    adId: z.string().max(100).nullable().default(null),
    campaign: z.string().max(200).nullable().default(null),
    name: z.string().trim().max(200).nullable().default(null),
    phone: z.string().trim().max(40).nullable().default(null),
    email: z.string().trim().toLowerCase().email().max(200).nullable().default(null),
    consent: leadConsentSchema,
  })
  .refine((l) => l.phone !== null || l.email !== null, {
    message: "El lead necesita un teléfono o un correo",
  });
export type NewLead = z.infer<typeof newLeadSchema>;
export type NewLeadInput = z.input<typeof newLeadSchema>;

export type Lead = {
  id: string;
  brokerId: string;
  source: LeadSource;
  externalId: string;
  listingId: string | null;
  adId: string | null;
  campaign: string | null;
  /** `null` cuando el lead se borró (`erasedAt`). */
  name: string | null;
  phone: string | null;
  email: string | null;
  consent: LeadConsent;
  status: LeadStatus;
  assignedTo: string | null;
  erasedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LeadDeps = {
  leads: LeadRepository;
  listings: Pick<ListingRepository, "get">;
};

/**
 * Guarda un lead que llegó de un origen. Es idempotente: el mismo `(corredor, origen, externalId)`
 * devuelve el existente sin duplicarlo. Sin consentimiento o sin contacto no se guarda nada. Si trae
 * una propiedad, debe ser del mismo corredor (la atribución no cruza corredores).
 */
export async function receiveLead(
  deps: LeadDeps,
  input: NewLeadInput,
): Promise<{ lead: Lead; created: boolean }> {
  const parsed = newLeadSchema.safeParse(input);
  if (!parsed.success) {
    const consentIssue = parsed.error.issues.some((i) => i.path[0] === "consent");
    throw new AppError(
      consentIssue ? "LEAD_CONSENT_REQUIRED" : "LEAD_INVALID",
      consentIssue ? "El lead no trae consentimiento" : "El lead no es válido",
      {
        details: { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
      },
    );
  }
  const data = parsed.data;
  if (data.listingId !== null) {
    const listing = await deps.listings.get(data.listingId);
    if (listing === null || listing.brokerId !== data.brokerId) {
      throw new AppError("LEAD_LISTING_INVALID", "La propiedad del lead no es de este corredor", {
        details: { listingId: data.listingId },
      });
    }
  }
  return deps.leads.create(data);
}

/** Cómo se nombra cada estado ante el operador (CLI y panel). */
export const LEAD_STATUS_TEXT: Readonly<Record<LeadStatus, string>> = {
  new: "nuevo",
  contacted: "contactado",
  visit_scheduled: "visita agendada",
  won: "ganado",
  lost: "perdido",
};

/** A qué estados puede pasar un lead desde cada uno. */
export const LEAD_TRANSITIONS: Readonly<Record<LeadStatus, readonly LeadStatus[]>> = {
  new: ["contacted", "lost"],
  contacted: ["visit_scheduled", "won", "lost"],
  visit_scheduled: ["contacted", "won", "lost"],
  won: [],
  lost: ["contacted"],
};

export async function changeLeadStatus(
  deps: Pick<LeadDeps, "leads">,
  leadId: string,
  to: LeadStatus,
): Promise<Lead> {
  const lead = await deps.leads.get(leadId);
  if (lead === null)
    throw new AppError("LEAD_NOT_FOUND", "No existe el lead", { details: { leadId } });
  if (lead.erasedAt !== null) {
    throw new AppError("LEAD_ERASED", "El lead fue borrado", { details: { leadId } });
  }
  if (!LEAD_TRANSITIONS[lead.status].includes(to)) {
    throw new AppError("LEAD_TRANSITION_INVALID", `No se pasa de ${lead.status} a ${to}`, {
      details: { leadId, from: lead.status, to },
    });
  }
  const updated = await deps.leads.setStatus(leadId, lead.status, to);
  if (updated === null) {
    throw new AppError("LEAD_TRANSITION_INVALID", "El lead cambió mientras tanto", {
      details: { leadId },
    });
  }
  return updated;
}

/** Borra los datos personales (nombre, teléfono, correo) y conserva el conteo y la atribución. */
export async function eraseLead(deps: Pick<LeadDeps, "leads">, leadId: string): Promise<Lead> {
  const erased = await deps.leads.erase(leadId);
  if (erased === null)
    throw new AppError("LEAD_NOT_FOUND", "No existe el lead", { details: { leadId } });
  return erased;
}

const CSV_HEADER = [
  "id",
  "recibido",
  "origen",
  "propiedad",
  "anuncio",
  "campaña",
  "estado",
  "nombre",
  "teléfono",
  "correo",
];

/** Una celda de CSV: comillas dobles, y sin que una planilla la tome por fórmula (= + - @). */
export function csvCell(value: string | null): string {
  if (value === null) return "";
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** Los leads del corredor como CSV; los borrados salen sin datos personales. */
export function leadsToCsv(leads: readonly Lead[]): string {
  const rows = leads.map((l) =>
    [
      l.id,
      l.createdAt.toISOString(),
      l.source,
      l.listingId,
      l.adId,
      l.campaign,
      l.status,
      l.name,
      l.phone,
      l.email,
    ].map((v) => csvCell(v)),
  );
  return [CSV_HEADER, ...rows].map((r) => r.join(",")).join("\n");
}
