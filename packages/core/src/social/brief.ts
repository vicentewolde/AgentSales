import type { BrandKnowledgeContext } from "../brand-knowledge.js";
import type { Broker } from "../broker.js";
import type { EditorialProfileView } from "../editorial-profile.js";
import { isPostPlatform, type Language, POST_PLATFORMS, type PostPlatform } from "../enums.js";
import type { PlatformAccount } from "../platform-account.js";
import type { Post } from "../post.js";
import { cardImageLimit, POST_CARDS } from "../post-cards.js";
import { linkKey, linksIn } from "./networks.js";
import { hashtagPolicy } from "./post-hashtags.js";
import { profileSpeaksAsTeam } from "./voice.js";

// Lo que ve la IA de un post (spec F9 §4.3 y §4.4, ADR-0030 punto 1): el perfil editorial de su
// marca, el tono y el tema; el brief del post **solo si lo escribió el operador**. Nunca datos de
// otras marcas: todo sale del perfil y del corredor del propio post.

/** Un texto por redactar: una red en un idioma. */
export type SocialTarget = { platform: PostPlatform; language: Language };

/**
 * Las redes de un post (F9-T11): las de `POST_PLATFORMS` donde la marca tiene una cuenta que no
 * está desconectada (una vencida o con error se reconecta y sigue siendo de la marca) **o** una
 * cadencia en su perfil editorial (redes que publica aunque todavía no conecte la cuenta). En el
 * orden de `POST_PLATFORMS`.
 */
export function postPlatforms(
  profile: Pick<EditorialProfileView, "cadence">,
  accounts: readonly Pick<PlatformAccount, "platform" | "status">[],
): PostPlatform[] {
  const connected = new Set(
    accounts
      .filter((account) => account.status !== "revoked" && isPostPlatform(account.platform))
      .map((account) => account.platform),
  );
  return POST_PLATFORMS.filter(
    (platform) => connected.has(platform) || profile.cadence[platform] !== undefined,
  );
}

/**
 * Los textos que redacta una corrida: cada red del post en cada idioma de la marca (spec F9 §4.4,
 * P4), primero por red y después por idioma (el principal primero).
 */
export function socialTargets(
  platforms: readonly PostPlatform[],
  languages: readonly Language[],
): SocialTarget[] {
  return platforms.flatMap((platform) => languages.map((language) => ({ platform, language })));
}

/**
 * Lo único que ve la IA de un post. `operatorBrief` y `operatorTopic` son las fuentes de hechos
 * del post además de `facts` (ADR-0030): el brief de un post de la IA (`briefOrigin = ai`) no
 * viaja, y el tema de una idea de la IA (`source = ai`) viaja como tema pero no como fuente.
 */
export type SocialBrief = {
  brandName: string;
  tone: string | null;
  languages: Language[];
  targets: SocialTarget[];
  audience: string | null;
  /** La línea de contenido del post (`posts.pillar`), si existe en el perfil. */
  pillar: { name: string; description: string } | null;
  facts: string[];
  avoid: string[];
  /**
   * Los hashtags que siempre van (`brokers.fixed_hashtags` y `defaultHashtags` del perfil, sin
   * repetir): el código los agrega al final en las redes que los usan (`applyHashtagPolicy`).
   */
  hashtags: string[];
  /** Si la IA puede agregar otros hashtags (`hashtagPolicy`, 2026-11-15). */
  aiMayAddHashtags: boolean;
  topic: string;
  /** `true` si el tema lo escribió el operador (un post manual): entonces es fuente de hechos. */
  topicIsSource: boolean;
  /** El brief del post, solo con `briefOrigin = operator`. */
  operatorBrief: string | null;
  kind: Post["kind"];
  /**
   * Los enlaces del brief del operador: los únicos que se permiten en X (spec F9 §4.4), y solo si
   * el post tiene la marca explícita (`xLinkAllowed`, F9-T16); sin ella, ninguno.
   */
  xLinks: string[];
  /**
   * Si un hecho del perfil dice que la marca es un equipo (`profileSpeaksAsTeam`, F9.5-T23): sin
   * eso, los textos no hablan de «nosotros».
   */
  speaksAsTeam: boolean;
  /**
   * Al rehacer un texto: lo que el operador quiere cambiar («más corto», «sin hashtags»). Es una
   * guía de forma y tono, **nunca** una fuente de hechos (la revisión no la cuenta como fuente).
   */
  guidance?: string | null;
  /** Al rehacer un solo texto: el texto actual, como referencia de forma (no es fuente de hechos). */
  currentText?: { body: string; hashtags: string[] } | null;
  /**
   * El conocimiento de la marca (spec F9.7 B3, ADR-0043): postura, tono y forma de contar, ejemplos
   * (guía de forma, nunca de hechos) y novedades (fuente de hechos). `null` si la marca no tiene.
   */
  knowledge: BrandKnowledgeContext | null;
  /**
   * Los textos de las láminas que se piden (spec F9.7 B5): en un post de imagen o carrusel, los
   * idiomas de los textos pedidos y cuántos puntos caben (0 en una imagen: solo la portada). `null`
   * en un post de texto o de video.
   */
  slides: { languages: Language[]; maxPoints: number } | null;
};

/** Hashtags sin repetir (sin mirar mayúsculas), en el orden en que llegan. */
function uniqueTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  return tags.filter((tag) => {
    const key = tag.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** El brief del post si cuenta como fuente (ADR-0030): lo escribió o editó el operador. */
export const operatorBriefOf = (post: Pick<Post, "brief" | "briefOrigin">): string | null =>
  post.briefOrigin === "operator" && post.brief !== null && post.brief.trim() !== ""
    ? post.brief.trim()
    : null;

/** Los enlaces que el operador marcó para X: los de su brief, en su forma comparable. */
export const xLinksOf = (post: Pick<Post, "brief" | "briefOrigin">): string[] => [
  ...new Set(linksIn(operatorBriefOf(post) ?? "").map(linkKey)),
];

/** Arma el brief de un post con el perfil de **su** marca y su corredor. */
export function buildSocialBrief(params: {
  post: Pick<
    Post,
    "topic" | "brief" | "briefOrigin" | "source" | "pillar" | "kind" | "xLinkAllowed"
  >;
  profile: EditorialProfileView;
  broker: Pick<Broker, "brandName" | "tone" | "fixedHashtags">;
  targets: readonly SocialTarget[];
}): SocialBrief {
  const { post, profile, broker } = params;
  const pillar = profile.pillars.find((item) => item.key === post.pillar) ?? null;
  return {
    brandName: broker.brandName,
    tone: broker.tone,
    // Los idiomas que se redactan (los del post, `postLanguages`); sin destinos, los de la marca.
    languages:
      params.targets.length > 0
        ? [...new Set(params.targets.map((target) => target.language))]
        : [...profile.languages],
    targets: params.targets.map((target) => ({ ...target })),
    audience: profile.audience,
    pillar: pillar === null ? null : { name: pillar.name, description: pillar.description },
    facts: [...profile.facts],
    avoid: [...profile.avoid],
    hashtags: uniqueTags([...broker.fixedHashtags, ...profile.defaultHashtags]),
    aiMayAddHashtags: hashtagPolicy(profile, broker).aiMayAdd,
    topic: post.topic,
    topicIsSource: post.source === "manual",
    operatorBrief: operatorBriefOf(post),
    kind: post.kind,
    // F9-T16: sin la marca del operador, la IA no pone enlaces en X (costarían US$0,20).
    xLinks: post.xLinkAllowed ? xLinksOf(post) : [],
    speaksAsTeam: profileSpeaksAsTeam(profile),
    knowledge: profile.knowledge ?? null,
    slides: slidesFor(post.kind, params.targets),
  };
}

/**
 * Las láminas que se piden con los textos (B5): un post de imagen lleva la portada; un carrusel,
 * la portada y un punto por lámina sin pasar el tope de la red más estricta (portada y cierre
 * aparte). Un post de texto o de video, ninguna.
 */
export function slidesFor(
  kind: Post["kind"],
  targets: readonly SocialTarget[],
): SocialBrief["slides"] {
  if (kind !== "image" && kind !== "carousel") return null;
  const languages = [...new Set(targets.map((target) => target.language))];
  if (languages.length === 0) return null;
  if (kind === "image") return { languages, maxPoints: 0 };
  const platforms = [...new Set(targets.map((target) => target.platform))];
  const limit = cardImageLimit(kind, platforms);
  return { languages, maxPoints: Math.max(0, Math.min(POST_CARDS.maxPoints, limit.max - 2)) };
}
