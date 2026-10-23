import type { PostMediaItem } from "@agentsales/api/contracts";
import { isExclusiveCard, LANGUAGE_TEXT, type Language } from "@agentsales/core";

// El idioma de las tarjetas de un post (F9.5, tarjetas por idioma): cada texto se publica por
// separado, así que cada uno lleva las tarjetas de su idioma. Funciones puras.

/**
 * El aviso de un texto sin tarjetas de su idioma, o `null` si no hace falta: el post no tiene
 * tarjetas, o ya tiene alguna **exclusiva** de este idioma (el cierre que comparte con otro idioma no
 * cuenta: si quedara solo él, el texto saldría con una sola imagen). Con tarjetas de otro idioma, o de
 * un pedido anterior al idioma (no se sabe en cuál están), la publicación de este texto usaría esas.
 */
export function cardLanguageNotice(
  media: readonly Pick<PostMediaItem, "cardLanguages">[],
  language: Language,
): string | null {
  const cards = media.flatMap((item) => (item.cardLanguages === null ? [] : [item.cardLanguages]));
  if (cards.length === 0 || cards.some((languages) => isExclusiveCard(languages, language))) {
    return null;
  }
  const others = [...new Set(cards.flat())]
    .filter((other) => other !== language)
    .map((other) => LANGUAGE_TEXT[other]);
  const where = `en «Conseguir imagen» haz las tarjetas en ${LANGUAGE_TEXT[language]}`;
  return others.length > 0
    ? `Este texto está en ${LANGUAGE_TEXT[language]}, pero las tarjetas del post están en ${others.join(" y ")}: ${where}.`
    : `Este texto está en ${LANGUAGE_TEXT[language]}, pero las tarjetas del post son de un pedido anterior y no se sabe en qué idioma están: ${where}.`;
}
