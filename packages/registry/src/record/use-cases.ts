import {
  AppError,
  type ListingRepository,
  type RegistryRecord,
  type RegistryRepository,
} from "@agentsales/core";
import { z } from "zod";
import { ClaimSchema, DeclaredSchema, PolicySchema } from "../claims/schema.js";
import { buildPayload, type ListingSource, payloadHash } from "./from-listing.js";

export const RegistryPayloadSchema = z.object({
  declared: DeclaredSchema,
  policy: PolicySchema,
  claims: z.array(ClaimSchema),
});

export type RegistryDeps = {
  listings: Pick<ListingRepository, "get">;
  registry: RegistryRepository;
};

/**
 * Arma (o rearma) el borrador del registro de una propiedad con lo que el corredor declaró.
 * Si nada cambió desde la última vez, el registro queda como estaba (aprobado sigue aprobado).
 */
export async function buildRegistry(
  deps: RegistryDeps,
  listingId: string,
): Promise<RegistryRecord> {
  const listing = await deps.listings.get(listingId);
  if (listing === null) {
    throw new AppError("LISTING_NOT_FOUND", `No existe la propiedad ${listingId}`, {
      details: { id: listingId },
    });
  }
  const source: ListingSource = listing;
  const payload = buildPayload(source);
  return deps.registry.upsert({
    listingId,
    brokerId: listing.brokerId,
    payload,
    contentHash: payloadHash(payload),
  });
}

/** El corredor aprueba lo que revisó: solo el borrador vigente, con su hash. Nada es público antes. */
export async function approveRegistry(
  deps: Pick<RegistryDeps, "registry">,
  listingId: string,
  userId: string,
): Promise<RegistryRecord> {
  const current = await deps.registry.get(listingId);
  if (current === null) {
    throw new AppError("REGISTRY_NOT_FOUND", "La propiedad aún no tiene registro", {
      details: { listingId },
    });
  }
  // El hash guardado debe corresponder al contenido guardado: si no, alguien lo alteró.
  const parsed = RegistryPayloadSchema.safeParse(current.payload);
  if (!parsed.success || payloadHash(parsed.data) !== current.contentHash) {
    throw new AppError(
      "REGISTRY_ROW_INVALID",
      "El contenido del registro no coincide con su hash",
      {
        details: { listingId },
      },
    );
  }
  const approved = await deps.registry.approve(listingId, userId, current.contentHash);
  if (approved === null) {
    throw new AppError(
      "REGISTRY_NOT_APPROVABLE",
      `El registro está ${current.status}, no se aprueba`,
      {
        details: { listingId, status: current.status },
      },
    );
  }
  return approved;
}
