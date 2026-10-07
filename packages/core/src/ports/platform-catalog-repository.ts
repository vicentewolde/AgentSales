import type { Platform } from "../enums.js";
import type { PlatformCatalogEntry } from "../platform-catalog.js";

/**
 * El catálogo guardado de las plataformas (`platform_catalog`, ADR-0015 punto 5): datos públicos que
 * solo se leen con token, con su fecha de bajada. El repositorio no interpreta `data` ni decide si
 * venció: eso lo hace quien lo usa (`createPortalCatalog`).
 * Errores:
 * - una entrada con otra forma al guardar (clave sin `tipo:id`, `data` que no es JSON) →
 *   `PLATFORM_CATALOG_ROW_INVALID` (no reintentable: la arma el servidor);
 * - la base caída → `DB_UNAVAILABLE` (reintentable).
 */
export interface PlatformCatalogRepository {
  /** La entrada de esa plataforma y clave, o `null` si no está. */
  get(platform: Platform, key: string): Promise<PlatformCatalogEntry | null>;
  /** Guarda la entrada; si la clave ya estaba, la reemplaza (`data` y `fetchedAt`). */
  put(entry: PlatformCatalogEntry): Promise<void>;
}
