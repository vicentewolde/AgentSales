import { AppError } from "../errors.js";

/**
 * `https://` + un host de Facebook (`facebook.com`, `www.`, `m.` o `web.`) + `/marketplace/item/<id>`,
 * con o sin `/` final, y después solo una consulta o un fragmento. Sin usuario, clave ni puerto.
 */
const ITEM_URL =
  /^https:\/\/(?:(?:www|m|web)\.)?facebook\.com\/marketplace\/item\/(\d{1,30})\/?(?:[?#][^\s]*)?$/i;

/** Un aviso de Marketplace reconocido: su id y su enlace limpio. */
export type MarketplaceItemRef = { itemId: string; url: string };

/** El enlace limpio de un aviso, como se guarda en `external_url`. */
export const marketplaceItemUrl = (itemId: string) =>
  `https://www.facebook.com/marketplace/item/${itemId}/`;

/**
 * Reconoce el enlace de un aviso de Marketplace (spec F5 §4.3), el que pega el operador o el que
 * ve el worker en la ventana: `https://www.facebook.com/marketplace/item/<dígitos>` (también
 * `facebook.com`, `m.` y `web.`, con o sin `/` final). Quita la consulta y el fragmento (traen
 * datos de rastreo) y devuelve la forma limpia. Cualquier otra cosa es `MARKETPLACE_URL_INVALID`
 * (no reintentable), sin repetir lo recibido en el mensaje.
 */
export function parseMarketplaceItemUrl(value: string): MarketplaceItemRef {
  const itemId = ITEM_URL.exec(value.trim())?.[1];
  if (itemId === undefined) {
    throw new AppError(
      "MARKETPLACE_URL_INVALID",
      "No es el enlace de un aviso de Marketplace: cópialo de la barra del navegador, con el número del aviso",
    );
  }
  return { itemId, url: marketplaceItemUrl(itemId) };
}

/** Si una dirección es la de un aviso de Marketplace (sin lanzar). */
export function isMarketplaceItemUrl(value: string): boolean {
  try {
    parseMarketplaceItemUrl(value);
    return true;
  } catch {
    return false;
  }
}
