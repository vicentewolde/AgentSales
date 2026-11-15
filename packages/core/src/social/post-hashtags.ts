import type { Broker } from "../broker.js";
import type { EditorialProfileView } from "../editorial-profile.js";
import type { PostPlatform } from "../enums.js";
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
  aiMayAdd: boolean;
};

/** La regla de la marca: con `aiHashtags = null`, la IA agrega otros solo si no hay fijos. */
export function hashtagPolicy(
  profile: Pick<EditorialProfileView, "defaultHashtags"> & { aiHashtags?: boolean | null },
  broker: Pick<Broker, "fixedHashtags">,
): HashtagPolicy {
  const always = normalizePostHashtags([...broker.fixedHashtags, ...profile.defaultHashtags]);
  return { always, aiMayAdd: profile.aiHashtags ?? always.length === 0 };
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
): string[] {
  const always = ALWAYS_HASHTAG_PLATFORMS.includes(platform) ? policy.always : [];
  const extra = policy.aiMayAdd ? tags : [];
  return normalizePostHashtags([...always, ...extra]);
}

/** Los hashtags de un texto que no están en la lista, cuando la IA no puede agregar otros. */
export function hashtagsOutsideList(tags: readonly string[], policy: HashtagPolicy): string[] {
  if (policy.aiMayAdd) return [];
  const allowed = new Set(policy.always.map(key));
  return normalizePostHashtags(tags).filter((tag) => !allowed.has(key(tag)));
}
