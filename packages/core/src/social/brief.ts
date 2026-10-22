import type { Broker } from "../broker.js";
import type { EditorialProfileView } from "../editorial-profile.js";
import { isPostPlatform, type Language, POST_PLATFORMS, type PostPlatform } from "../enums.js";
import type { PlatformAccount } from "../platform-account.js";
import type { Post } from "../post.js";
import { linkKey, linksIn } from "./networks.js";
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
  /** `brokers.fixed_hashtags` y `defaultHashtags` del perfil, sin repetir. */
  hashtags: string[];
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
    languages: [...profile.languages],
    targets: params.targets.map((target) => ({ ...target })),
    audience: profile.audience,
    pillar: pillar === null ? null : { name: pillar.name, description: pillar.description },
    facts: [...profile.facts],
    avoid: [...profile.avoid],
    hashtags: uniqueTags([...broker.fixedHashtags, ...profile.defaultHashtags]),
    topic: post.topic,
    topicIsSource: post.source === "manual",
    operatorBrief: operatorBriefOf(post),
    kind: post.kind,
    // F9-T16: sin la marca del operador, la IA no pone enlaces en X (costarían US$0,20).
    xLinks: post.xLinkAllowed ? xLinksOf(post) : [],
    speaksAsTeam: profileSpeaksAsTeam(profile),
  };
}
