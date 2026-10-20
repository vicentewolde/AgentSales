import type { Platform, PlatformCatalogRepository, PublicationOperations } from "@agentsales/core";
import {
  createMercadoLibreCatalogApi,
  createMercadoLibreItems,
  createPortalCatalog,
  createPortalOperations,
  MERCADOLIBRE_API_TIMEOUT_MS,
  type MercadoLibreHttpOptions,
  type MercadoLibreItems,
} from "@agentsales/publishers";
import { createLinkedInApi, createLinkedInOperations } from "@agentsales/publishers/linkedin";

/**
 * Las operaciones de cada plataforma para la API (pausar, reactivar, cerrar y el sync de Portal;
 * spec F4 §4.9, F4-T19; actualizar un aviso publicado desde F6-T07, ADR-0020): el cliente de ítems
 * con 10 s por llamada (`MERCADOLIBRE_API_TIMEOUT_MS`: el operador espera la respuesta) y, para
 * actualizar, el catálogo de Mercado Libre con su caché en la base. Sin fotos: actualizar usa las
 * del ítem. **Sin envolver**: el modo lo decide cada publicación. `createItems` es el cliente real;
 * los tests revisan con qué tope se arma. Sin `catalogRepository`, actualizar no está configurado.
 * Desde F9-T19, también borrar un post de LinkedIn al retirarlo (con el mismo tope de 10 s).
 */
export function createApiOperations(
  createItems: (options: MercadoLibreHttpOptions) => MercadoLibreItems = createMercadoLibreItems,
  catalogRepository?: PlatformCatalogRepository,
): (platform: Platform) => PublicationOperations | undefined {
  const portal = createPortalOperations({
    items: createItems({ timeoutMs: MERCADOLIBRE_API_TIMEOUT_MS }),
    ...(catalogRepository === undefined
      ? {}
      : {
          catalog: createPortalCatalog({
            api: createMercadoLibreCatalogApi({ timeoutMs: MERCADOLIBRE_API_TIMEOUT_MS }),
            repository: catalogRepository,
          }),
        }),
  });
  const linkedin = createLinkedInOperations({
    api: createLinkedInApi({ timeoutMs: MERCADOLIBRE_API_TIMEOUT_MS }),
  });
  return (platform) =>
    platform === "portal_inmobiliario" ? portal : platform === "linkedin" ? linkedin : undefined;
}
