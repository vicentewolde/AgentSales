import type { Lead, LeadStatus, NewLead } from "../leads.js";

export type LeadFilters = { brokerId: string; status?: LeadStatus; listingId?: string };

/**
 * Los leads (`leads`). Nombre, teléfono y correo se guardan cifrados (el repositorio recibe el
 * `SecretBox`); aquí se ven en claro hasta que se borran.
 */
export interface LeadRepository {
  /** Idempotente por `(brokerId, source, externalId)`: `created: false` si ya existía. */
  create(input: NewLead): Promise<{ lead: Lead; created: boolean }>;
  get(id: string): Promise<Lead | null>;
  list(filters: LeadFilters, limit: number): Promise<Lead[]>;
  /** Cambia el estado solo si sigue en `from`; `null` si ya no lo estaba o no existe. */
  setStatus(id: string, from: LeadStatus, to: LeadStatus): Promise<Lead | null>;
  assign(id: string, userId: string | null): Promise<Lead | null>;
  /** Deja nulos nombre, teléfono y correo, y anota `erasedAt`. Idempotente. */
  erase(id: string): Promise<Lead | null>;
}
