import type { EditorialProfile, EditorialProfileData } from "../editorial-profile.js";

/**
 * El perfil editorial de cada marca (`editorial_profiles`, spec F9 §4.3): uno por corredor.
 * Lectura y escritura básicas; la validación de sus reglas y quién lo edita llegan en F9-T09.
 * Errores (`AppError`):
 * - `upsert` de un corredor que no existe → `EDITORIAL_PROFILE_REFERENCE_INVALID`;
 * - una fila que no calza con la entidad (por ejemplo, un idioma fuera de `LANGUAGES`) →
 *   `EDITORIAL_PROFILE_ROW_INVALID`;
 * - fallo de conexión → `DB_UNAVAILABLE`, reintentable.
 */
export interface EditorialProfileRepository {
  /** El perfil del corredor; `null` si todavía no tiene. */
  get(brokerId: string): Promise<EditorialProfile | null>;
  /** Crea o reemplaza el perfil completo del corredor (y su `updated_at`). */
  upsert(brokerId: string, profile: EditorialProfileData): Promise<EditorialProfile>;
}
