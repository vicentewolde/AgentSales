import { z } from "zod";

// El registro verificable de una propiedad (F12, ADR-0039). Core solo guarda y mueve el estado; el
// contenido (afirmaciones, política) es de `@agentsales/registry`, que lo valida al leer.

export const REGISTRY_STATUSES = ["draft", "approved", "withdrawn"] as const;
export type RegistryStatus = (typeof REGISTRY_STATUSES)[number];

export const registryRecordSchema = z.object({
  id: z.string(),
  listingId: z.string(),
  brokerId: z.string(),
  status: z.enum(REGISTRY_STATUSES),
  /** Lo declarado, la política y las afirmaciones: `registry` los valida (jsonb). */
  payload: z.unknown(),
  /** sha256 del contenido canónico; si cambia al reconstruir, la aprobación se pierde. */
  contentHash: z.string().length(64),
  approvedAt: z.date().nullable(),
  approvedBy: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type RegistryRecord = z.infer<typeof registryRecordSchema>;
