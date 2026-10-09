import type { Platform, PublicationOperations } from "@agentsales/core";
import {
  createMercadoLibreItems,
  createPortalOperations,
  MERCADOLIBRE_API_TIMEOUT_MS,
  type MercadoLibreHttpOptions,
  type MercadoLibreItems,
} from "@agentsales/publishers";

/**
 * Las operaciones de cada plataforma para la API (pausar, reactivar, cerrar y el sync de Portal;
 * spec F4 §4.9, F4-T19): solo el cliente de ítems, sin fotos ni catálogo, con 10 s por llamada
 * (`MERCADOLIBRE_API_TIMEOUT_MS`: el operador espera la respuesta). **Sin envolver**: el modo lo
 * decide cada publicación. `createItems` es el cliente real; los tests revisan con qué tope se arma.
 */
export function createApiOperations(
  createItems: (options: MercadoLibreHttpOptions) => MercadoLibreItems = createMercadoLibreItems,
): (platform: Platform) => PublicationOperations | undefined {
  const portal = createPortalOperations({
    items: createItems({ timeoutMs: MERCADOLIBRE_API_TIMEOUT_MS }),
  });
  return (platform) => (platform === "portal_inmobiliario" ? portal : undefined);
}
