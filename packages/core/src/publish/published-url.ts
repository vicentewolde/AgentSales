import type { Platform } from "../enums.js";
import { AppError } from "../errors.js";
import { parseMarketplaceItemUrl } from "../marketplace/url.js";

/**
 * `https://` + un host (letras, dígitos, puntos y guiones; sin usuario, clave ni puerto) + una ruta
 * opcional, y después solo una consulta o un fragmento. Con una expresión y no con `URL`: core no
 * carga los tipos de Node ni del navegador.
 */
const PUBLISHED_URL = /^(https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s?#]*)?)(?:[?#]\S*)?$/i;

/** Largo máximo del enlace que se guarda (`external_url`). */
export const PUBLISHED_URL_MAX_LENGTH = 500;

/** Lo publicado según el enlace que pegó el operador: el id en la red y el enlace limpio. */
export type PublishedRefFromUrl = { externalId: string; url: string };

/**
 * El enlace de lo publicado que pega el operador al confirmar o resolver (ADR-0029 puntos 8 y 9):
 * - Marketplace: `parseMarketplaceItemUrl` (el número del aviso; `MARKETPLACE_URL_INVALID`);
 * - las demás: un enlace `https` (sin usuario, clave ni puerto) de hasta 500 caracteres, sin la
 *   consulta ni el fragmento (traen datos de rastreo); el id es el mismo enlace limpio. Si no,
 *   `PUBLISHED_URL_INVALID` (no reintentable), sin repetir lo recibido en el mensaje.
 * Que el host sea el de la red lo revisa su publisher cuando exista (F9-T13 a T16).
 */
export function parsePublishedUrl(platform: Platform, value: string): PublishedRefFromUrl {
  if (platform === "fb_marketplace") {
    const item = parseMarketplaceItemUrl(value);
    return { externalId: item.itemId, url: item.url };
  }
  const clean = PUBLISHED_URL.exec(value.trim())?.[1];
  if (clean === undefined || clean.length > PUBLISHED_URL_MAX_LENGTH) {
    throw new AppError(
      "PUBLISHED_URL_INVALID",
      "No es el enlace de una publicación: cópialo de la barra del navegador (empieza con https://)",
      { details: { platform } },
    );
  }
  return { externalId: clean, url: clean };
}
