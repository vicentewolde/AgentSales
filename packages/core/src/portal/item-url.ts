import { AppError } from "../errors.js";

/**
 * `https://` + un host de Portal Inmobiliario o de Mercado Libre Chile (con o sin subdominio:
 * `www.portalinmobiliario.com`, `departamento.mercadolibre.cl`, `articulo.mercadolibre.cl`…) + una
 * ruta opcional, y después solo una consulta o un fragmento (se descartan: traen datos de rastreo).
 * Con una expresión y no con `URL`: core no carga los tipos de Node ni del navegador.
 */
const PORTAL_ITEM_URL =
  /^(https:\/\/(?:[a-z0-9-]+\.)*(?:portalinmobiliario\.com|mercadolibre\.cl)(\/[^\s?#]*)?)(?:[?#]\S*)?$/i;

/** El id del ítem dentro de la ruta: `MLC` y dígitos, con o sin guion (`MLC-123` en los enlaces). */
const ITEM_IN_PATH = /(?:^|[^a-z0-9])MLC-?(\d{1,20})(?!\d)/i;

/** Solo el id, como lo muestra Mercado Libre en «Mis publicaciones» (`MLC123`) o en el enlace (`MLC-123`). */
const ITEM_ID = /^MLC-?(\d{1,20})$/i;

/** Largo máximo del enlace que se guarda (`external_url`), como `PUBLISHED_URL_MAX_LENGTH`. */
const MAX_LENGTH = 500;

/** Un aviso de Portal reconocido: el id del ítem (`MLC123…`) y el enlace limpio, si se pegó uno. */
export type PortalItemRef = { itemId: string; url: string | null };

/**
 * Reconoce el aviso de Portal que pega el operador al resolver un resultado dudoso (F9.5-T04a):
 * un enlace `https` de Portal Inmobiliario o de Mercado Libre Chile con el id del ítem en la ruta
 * (`…/MLC-1234567890-depto-_JM`), o solo el id (`MLC1234567890` o `MLC-1234567890`). El id queda
 * como lo guarda el publisher (`MLC` + dígitos, sin guion), así sync, pausar, reactivar, cerrar,
 * actualizar y republicar lo encuentran. Sin red: que el ítem sea de la cuenta lo dice el sync.
 * Cualquier otra cosa es `PUBLISHED_URL_INVALID` (no reintentable, el código de las demás redes),
 * sin repetir lo recibido en el mensaje.
 */
export function parsePortalItemRef(value: string): PortalItemRef {
  const trimmed = value.trim();
  const bare = ITEM_ID.exec(trimmed)?.[1];
  if (bare !== undefined) return { itemId: `MLC${bare}`, url: null };
  const match = PORTAL_ITEM_URL.exec(trimmed);
  const clean = match?.[1];
  const digits = ITEM_IN_PATH.exec(match?.[2] ?? "")?.[1];
  if (clean === undefined || digits === undefined || clean.length > MAX_LENGTH) {
    throw new AppError(
      "PUBLISHED_URL_INVALID",
      "No es el enlace de un aviso de Portal Inmobiliario o Mercado Libre: cópialo de la barra del navegador con el aviso abierto, o escribe su número de publicación (empieza con MLC)",
      { details: { platform: "portal_inmobiliario" } },
    );
  }
  return { itemId: `MLC${digits}`, url: clean };
}
