import type { RegistryRecord } from "../registry.js";

export type RegistryUpsert = {
  listingId: string;
  brokerId: string;
  payload: unknown;
  contentHash: string;
};

/** El registro de cada propiedad (`registry_records`): uno por propiedad. */
export interface RegistryRepository {
  get(listingId: string): Promise<RegistryRecord | null>;
  /**
   * Crea el borrador o lo actualiza. Si el contenido (hash) no cambió, no toca nada y devuelve el
   * registro tal cual (aprobado sigue aprobado); si cambió, vuelve a `draft` y quita la aprobación.
   */
  upsert(input: RegistryUpsert): Promise<RegistryRecord>;
  /** `draft` → `approved` (solo con el hash que se revisó). `null` si no estaba en ese estado. */
  approve(listingId: string, userId: string, contentHash: string): Promise<RegistryRecord | null>;
  /** Cualquier estado → `withdrawn`. `null` si no existe. */
  withdraw(listingId: string): Promise<RegistryRecord | null>;
}
