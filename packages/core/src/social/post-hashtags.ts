import type { Broker } from "../broker.js";
import type { EditorialProfileView } from "../editorial-profile.js";
import type { Language, PostPlatform } from "../enums.js";
import { normalizePostHashtags } from "./draft.js";

// «Hashtags que siempre van» (2026-11-15): los hashtags fijos de la marca (`brokers.fixed_hashtags`,
// en «Marca») y los del perfil editorial (`defaultHashtags`, en «Mi marca») van al final de cada
// texto de post en las redes que usan hashtags, los ponga o no la IA. La IA agrega otros solo si el
// perfil lo permite (`aiHashtags`; por defecto, no cuando hay hashtags que siempre van).

/** Las redes donde van los hashtags que siempre van (Discord no usa hashtags). */
export const ALWAYS_HASHTAG_PLATFORMS: readonly PostPlatform[] = [
  "instagram",
  "x",
  "linkedin",
  "tiktok",
];

/** La regla de hashtags de una marca: los que siempre van y si la IA puede agregar otros. */
export type HashtagPolicy = {
  /** Normalizados (`#palabra`), sin repetir: los fijos de la marca y después los del perfil. */
  always: string[];
  /**
   * Los que siempre van solo en los textos de un idioma (2026-11-21, `hashtagsByLanguage` del
   * perfil), después de `always`. Sin el campo, ninguno: lo de antes.
   */
  byLanguage?: Partial<Record<Language, string[]>>;
  aiMayAdd: boolean;
};

/**
 * La regla de la marca: con `aiHashtags = null`, la IA agrega otros solo si no hay fijos (ni de
 * todos los idiomas ni de alguno).
 */
export function hashtagPolicy(
  profile: Pick<EditorialProfileView, "defaultHashtags" | "hashtagsByLanguage"> & {
    aiHashtags?: boolean | null;
  },
  broker: Pick<Broker, "fixedHashtags">,
): HashtagPolicy {
  const always = normalizePostHashtags([...broker.fixedHashtags, ...profile.defaultHashtags]);
  const byLanguage: Partial<Record<Language, string[]>> = {};
  for (const [language, tags] of Object.entries(profile.hashtagsByLanguage ?? {})) {
    const normalized = normalizePostHashtags(tags ?? []);
    if (normalized.length > 0) byLanguage[language as Language] = normalized;
  }
  const hasByLanguage = Object.keys(byLanguage).length > 0;
  return {
    always,
    ...(hasByLanguage ? { byLanguage } : {}),
    aiMayAdd: profile.aiHashtags ?? (always.length === 0 && !hasByLanguage),
  };
}

/**
 * Los que siempre van en un texto de ese idioma: los de todos los idiomas y después los de su
 * idioma, sin repetir. Sin idioma, solo los de todos.
 */
export function alwaysHashtagsFor(policy: HashtagPolicy, language?: Language): string[] {
  const own = language === undefined ? [] : (policy.byLanguage?.[language] ?? []);
  return normalizePostHashtags([...policy.always, ...own]);
}

const key = (tag: string) => tag.toLowerCase();

/**
 * Los hashtags finales de un texto redactado por la IA: en las redes que los usan, primero los que
 * siempre van; después los de la IA que no estén ya, solo si puede agregar otros. Nunca corta el
 * texto: si no cabe, lo dice la revisión (`TOO_LONG`).
 */
export function applyHashtagPolicy(
  platform: PostPlatform,
  tags: readonly string[],
  policy: HashtagPolicy,
  /** El idioma del texto: suma los que siempre van en ese idioma (2026-11-21). */
  language?: Language,
): string[] {
  const always = ALWAYS_HASHTAG_PLATFORMS.includes(platform)
    ? alwaysHashtagsFor(policy, language)
    : [];
  const extra = policy.aiMayAdd ? tags : [];
  return normalizePostHashtags([...always, ...extra]);
}

/**
 * Los hashtags de un texto que no están en la lista, cuando la IA no puede agregar otros. Con el
 * idioma del texto, valen los de todos los idiomas y los de ese idioma (los de otro idioma, no).
 */
export function hashtagsOutsideList(
  tags: readonly string[],
  policy: HashtagPolicy,
  language?: Language,
): string[] {
  if (policy.aiMayAdd) return [];
  const allowed = new Set(alwaysHashtagsFor(policy, language).map(key));
  return normalizePostHashtags(tags).filter((tag) => !allowed.has(key(tag)));
}

/**
 * Las palabras de un hashtag pegado (2026-11-21), para que la revisión de hechos lo reconozca en el
 * texto: `#BlackFriday` → «Black Friday», `#AIAgents` → «AI Agents», `#Web3` → «Web 3»,
 * `#cyber_monday` → «cyber monday». Corta en `_`, entre minúscula y mayúscula, entre una sigla y la
 * palabra que sigue (`AIAgents`) y entre letras y números. Uno todo en minúsculas no se puede
 * separar: queda como está.
 */
export function hashtagWords(tag: string): string {
  return tag
    .replace(/^#+/u, "")
    .replace(/_+/gu, " ")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})/gu, "$1 $2")
    .replace(/(\p{N})(\p{L})/gu, "$1 $2")
    .replace(/\s+/gu, " ")
    .trim();
}
