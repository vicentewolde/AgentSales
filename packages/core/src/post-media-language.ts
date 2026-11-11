import type { Language, MediaRole, Platform } from "./enums.js";
import { type CardLanguages, hiddenCardIds } from "./post-card-languages.js";

// El idioma de cada imagen de un post (ADR-0042): una foto o un video subido puede ser de un idioma
// (`media.language`) o de todos (`null`, lo de siempre). Qué medios lleva el texto de una red en un
// idioma lo decide `mediaForText`, la misma regla en la publicación, la revisión del texto, la vista
// previa y «Qué se publica» del panel. Funciones puras.

/**
 * Lo mínimo de un medio para elegir por idioma. Sin `role`, es un original (los medios del panel
 * son solo originales); una variante sigue a su original (`parentMediaId`).
 */
export type LanguageMediaItem = {
  id: string;
  sortOrder: number;
  role?: MediaRole;
  parentMediaId?: string | null;
  language?: Language | null;
};

/** El idioma marcado de un medio; `null` (o sin el campo): sirve para todos los idiomas. */
export const mediaLanguageOf = (item: Pick<LanguageMediaItem, "language">): Language | null =>
  item.language ?? null;

/** 0 si el medio es del idioma del texto o de todos; 1 si está marcado en otro idioma. */
export const languageRank = (item: Pick<LanguageMediaItem, "language">, language: Language) => {
  const own = mediaLanguageOf(item);
  return own === null || own === language ? 0 : 1;
};

/**
 * El orden de los originales para un texto de `language`: primero los de su idioma y los de todos,
 * después los de otros idiomas; cada grupo por `sortOrder` y luego el id.
 */
export const byLanguageThenOrder =
  (language: Language) =>
  (a: LanguageMediaItem, b: LanguageMediaItem): number =>
    languageRank(a, language) - languageRank(b, language) ||
    a.sortOrder - b.sortOrder ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Si en esa red un texto lleva también los medios de otros idiomas: solo Instagram, donde el
 * operador publica **un** post bilingüe (un texto con los dos idiomas y las imágenes de ambos).
 */
export const carriesAllLanguages = (platform: Platform): boolean => platform === "instagram";

const isOriginal = (item: LanguageMediaItem) => (item.role ?? "original") === "original";

/**
 * Los medios (originales y variantes) que lleva el texto de `platform` en `language`:
 * - las tarjetas, por su regla de idioma (`hiddenCardIds`, ADR-0038), en todas las redes;
 * - en X, LinkedIn, Discord y TikTok, solo los originales de su idioma o de todos;
 * - en Instagram, todos, con los de su idioma (y de todos) primero.
 * Los originales salen en el orden de `byLanguageThenOrder` y después sus variantes (las que
 * siguen a un original que no va, tampoco van). Sin marcas de idioma ni tarjetas, son todos.
 */
export function mediaForText<M extends LanguageMediaItem>(
  media: readonly M[],
  cards: CardLanguages,
  platform: Platform,
  language: Language,
): M[] {
  const originals = media.filter(isOriginal);
  const hidden =
    cards.size === 0
      ? new Set<string>()
      : hiddenCardIds(
          originals.map((item) => item.id),
          cards,
          language,
        );
  const all = carriesAllLanguages(platform);
  const kept = originals
    .filter((item) => !hidden.has(item.id) && (all || languageRank(item, language) === 0))
    .sort(byLanguageThenOrder(language));
  const keptIds = new Set(kept.map((item) => item.id));
  const derived = media.filter(
    (item) =>
      !isOriginal(item) &&
      (item.parentMediaId === undefined ||
        item.parentMediaId === null ||
        keptIds.has(item.parentMediaId)),
  );
  return [...kept, ...derived];
}

/**
 * Los originales que **no** van con el texto solo por su idioma (marcados en otro idioma, fuera de
 * Instagram): para decir «las imágenes del post están en otro idioma» en vez de «no tiene ninguna».
 */
export function otherLanguageOriginals<M extends LanguageMediaItem>(
  media: readonly M[],
  platform: Platform,
  language: Language,
): M[] {
  if (carriesAllLanguages(platform)) return [];
  return media.filter((item) => isOriginal(item) && languageRank(item, language) === 1);
}

/**
 * Si las imágenes de un texto de Instagram forman un post bilingüe (ADR-0042, punto 3): 2 o más y
 * alguna marcada en otro idioma. Entonces un post de tipo imagen sale como carrusel con todas, en
 * vez de solo la primera. `images` son los originales de imagen que lleva el texto.
 */
export const isBilingualImageSet = (
  images: readonly Pick<LanguageMediaItem, "language">[],
  language: Language,
): boolean => images.length >= 2 && images.some((item) => languageRank(item, language) === 1);
