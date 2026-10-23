import { LANGUAGES, type Language } from "./enums.js";
import type { Media } from "./media.js";
import type { PostImageRunRepository } from "./ports/post-image-run-repository.js";
import type { PostImageRun } from "./post-image.js";

// El idioma de las tarjetas de un post (F9.5, arreglo del idioma de las tarjetas, ADR-0038): cada
// pedido de tarjetas es de un idioma (`request.language`) y los medios que dejó son sus tarjetas.
// No hay columna nueva: el idioma de un medio se deduce de los pedidos terminados del post, así que
// no hay nada que mantener al día.

/**
 * Los medios del post que son tarjetas y los idiomas en que se hicieron: el id del medio → sus
 * idiomas. Un medio con la lista vacía es una tarjeta de un pedido anterior al idioma (de idioma
 * desconocido). Un mismo medio puede estar en dos idiomas (el cierre con la marca es idéntico, y
 * un contenido idéntico es el mismo medio). Un medio que no está aquí no es una tarjeta (una foto
 * subida, de la biblioteca o con IA).
 */
export type CardLanguages = ReadonlyMap<string, readonly Language[]>;

/** Los pedidos de un post que se leen para saber de qué idioma es cada tarjeta. */
export const ALL_CARD_RUNS = 500;

/** El idioma de cada tarjeta, desde los pedidos de tarjetas terminados del post. */
export function cardLanguagesOf(
  runs: readonly Pick<PostImageRun, "source" | "status" | "request" | "mediaIds">[],
): CardLanguages {
  const cards = new Map<string, Language[]>();
  for (const run of runs) {
    if (run.source !== "card" || run.status !== "succeeded") continue;
    const language = run.request.source === "card" ? run.request.language : undefined;
    for (const id of run.mediaIds) {
      const languages = cards.get(id) ?? [];
      if (language !== undefined && !languages.includes(language)) languages.push(language);
      cards.set(id, languages);
    }
  }
  // En el orden de `LANGUAGES`, no en el de los pedidos (el más nuevo primero).
  for (const languages of cards.values()) {
    languages.sort((a, b) => LANGUAGES.indexOf(a) - LANGUAGES.indexOf(b));
  }
  return cards;
}

/**
 * Lo mismo, leyendo los pedidos del repositorio. Sin repositorio (quien llama no lo tiene), vacío:
 * ninguna tarjeta se separa por idioma, como antes.
 */
export async function loadCardLanguages(
  runs: Pick<PostImageRunRepository, "listByPost"> | undefined,
  postId: string,
): Promise<CardLanguages> {
  if (runs === undefined) return new Map();
  return cardLanguagesOf(await runs.listByPost(postId, ALL_CARD_RUNS));
}

/** Si una tarjeta es solo de ese idioma (no la comparten dos: el cierre con la marca lo es). */
export const isExclusiveCard = (languages: readonly Language[], language: Language): boolean =>
  languages.length === 1 && languages[0] === language;

/**
 * Las tarjetas que **no** van en una publicación de `language`, entre los originales del post
 * (sus ids). Lo que sube el usuario, la biblioteca y la IA nunca se esconde. Para las tarjetas:
 * - si ese idioma tiene al menos una tarjeta **exclusiva** (no cuenta el cierre que comparte con
 *   otro idioma: si quedara solo él, el texto saldría con una sola imagen), las de ese idioma, las
 *   exclusivas y las compartidas; las de otro idioma y las de idioma desconocido no van;
 * - si no, las únicas que haya, sin mezclar: primero las de idioma desconocido y, si no hay, todas
 *   las demás.
 */
export function hiddenCardIds(
  originalIds: readonly string[],
  cards: CardLanguages,
  language: Language,
): Set<string> {
  const present = originalIds.filter((id) => cards.has(id));
  const languagesOf = (id: string) => cards.get(id) ?? [];
  const hasOwn = present.some((id) => isExclusiveCard(languagesOf(id), language));
  const unknown = present.filter((id) => languagesOf(id).length === 0);
  const chosen = hasOwn
    ? present.filter((id) => languagesOf(id).includes(language))
    : unknown.length > 0
      ? unknown
      : present;
  return new Set(present.filter((id) => !chosen.includes(id)));
}

/**
 * Los medios (originales y variantes) que lleva una publicación de `language`: todos menos las
 * tarjetas de otro idioma (`hiddenCardIds`) y sus variantes.
 */
export function mediaForLanguage(
  media: readonly Media[],
  cards: CardLanguages,
  language: Language,
): Media[] {
  if (cards.size === 0) return [...media];
  const hidden = hiddenCardIds(
    media.filter((item) => item.role === "original").map((item) => item.id),
    cards,
    language,
  );
  if (hidden.size === 0) return [...media];
  return media.filter(
    (item) =>
      !hidden.has(item.id) && !(item.parentMediaId !== null && hidden.has(item.parentMediaId)),
  );
}
