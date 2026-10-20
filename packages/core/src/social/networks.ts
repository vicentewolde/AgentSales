import { EMOJI_PATTERN, INSTAGRAM_CAPTION_MAX_LENGTH } from "../content/assemble.js";
import type { PostKind, PostPlatform } from "../enums.js";

// Las reglas de texto de cada red para los posts (spec F9 §4.4): cuánto puede medir, cómo se
// cuenta y qué caracteres hay que escapar. Funciones puras: las usan la revisión
// (`checkPostContent`), el contador del editor y los publishers de cada red (T13 a T16).

/**
 * El largo máximo del texto de cada red, como lo cuenta esa red (`postTextLength`): Instagram
 * 2.200 (con los hashtags), X 280 ponderados (`x.md` §5.4), LinkedIn 3.000 (`linkedin.md` §5.3),
 * Discord 2.000 (`discord.md` §1) y TikTok 2.200 (`tiktok.md` §6, el caption del video).
 */
export const POST_TEXT_LIMITS: Readonly<Record<PostPlatform, number>> = {
  instagram: INSTAGRAM_CAPTION_MAX_LENGTH,
  x: 280,
  linkedin: 3000,
  discord: 2000,
  tiktok: 2200,
};

/** Instagram rechaza un caption con más de 30 hashtags. */
export const INSTAGRAM_HASHTAGS_LIMIT = 30;

/** X: hasta 4 imágenes o 1 video por post (`x.md` §5.2). */
export const X_MAX_IMAGES = 4;

/** Discord: hasta 10 archivos por mensaje (`discord.md` §1). */
export const DISCORD_MAX_FILES = 10;

/**
 * Lo que cuesta un post en X (`x.md` §2, spec F9 §4.12): US$0,015; con un enlace, US$0,20. Son
 * estimaciones (los precios de X cambian): las anota `publications.cost_usd` (F9-T16).
 */
export const X_POST_COST_USD = 0.015;
export const X_LINK_POST_COST_USD = 0.2;

/** Lo que pesa una URL en el conteo de X, sea cual sea su largo (se acorta con `t.co`). */
export const X_URL_WEIGHT = 23;

/**
 * Dominios de primer nivel que se reconocen en un enlace sin `http` (`agentpey.com`): X los
 * convierte en enlace (y los cobra), así que la revisión también. No es la lista completa de la
 * IANA: son los frecuentes en Chile y en tecnología.
 */
const BARE_TLDS = [
  "com",
  "cl",
  "net",
  "org",
  "io",
  "ai",
  "app",
  "dev",
  "co",
  "me",
  "info",
  "xyz",
  "tech",
  "store",
  "shop",
  "lat",
  "us",
  "es",
  "mx",
  "ar",
  "pe",
  "uk",
];

/**
 * Un enlace en el texto: con `http(s)://` o `www.`, o un dominio con uno de `BARE_TLDS` (con su
 * ruta, si tiene). Termina antes de un espacio, de `<>()[]{}"` y de la puntuación final.
 */
const LINK_SOURCE = String.raw`(?:https?:\/\/|www\.)[^\s<>()\[\]{}"]*[^\s<>()\[\]{}".,;:!?'’]|\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:${BARE_TLDS.join("|")})\b(?:\/[^\s<>()\[\]{}"]*[^\s<>()\[\]{}".,;:!?'’])?`;

/** Un patrón nuevo cada vez (con `g`, `lastIndex` es estado). */
export const linkPattern = (): RegExp => new RegExp(LINK_SOURCE, "giu");

/** Los enlaces de un texto, tal cual aparecen. */
export const linksIn = (text: string): string[] => text.match(linkPattern()) ?? [];

/**
 * La forma comparable de un enlace: sin `http(s)://`, sin `www.`, en minúsculas y sin `/` final.
 * `https://www.AgentPey.com/` y `agentpey.com` son el mismo.
 */
export const linkKey = (link: string): string =>
  link
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");

/**
 * El texto completo de un post en una red: el cuerpo y, si hay, los hashtags en un párrafo aparte
 * separados por espacios (como `instagramCaption`). Es lo que mide `postTextLength`; el texto que
 * se envía a cada red (`socialCaption`, F9-T06) debe armarse igual, o medir con esta función.
 */
export function joinedPostText(text: { body: string; hashtags: readonly string[] }): string {
  return text.hashtags.length === 0 ? text.body : `${text.body}\n\n${text.hashtags.join(" ")}`;
}

/** Los caracteres reservados del formato "little text" de LinkedIn (`linkedin.md` §5.3). */
export const LINKEDIN_RESERVED_CHARACTERS = [
  "|",
  "{",
  "}",
  "@",
  "[",
  "]",
  "(",
  ")",
  "<",
  ">",
  "#",
  "\\",
  "*",
  "_",
  "~",
] as const;

const LINKEDIN_RESERVED = /[|{}@[\]()<>#\\*_~]/g;

/**
 * El texto con los 15 caracteres reservados de LinkedIn escapados con una barra invertida (campo
 * `commentary`, `linkedin.md` §5.3): LinkedIn exige escaparlos todos, aunque no formen una
 * mención ni un hashtag, así que los hashtags salen como texto. La barra misma también se escapa,
 * en la misma pasada (nunca se escapa dos veces).
 */
export const escapeLinkedInText = (text: string): string =>
  text.replace(LINKEDIN_RESERVED, (char) => `\\${char}`);

/**
 * Rangos de puntos de código que pesan 1 en X (la configuración v3 de `twitter-text`): el latín
 * con tildes, el griego, el cirílico y la puntuación general. Todo lo demás (CJK, por ejemplo)
 * pesa 2.
 */
const X_LIGHT_RANGES: readonly (readonly [number, number])[] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

const isLight = (codePoint: number) =>
  X_LIGHT_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);

const EMOJI = new RegExp(EMOJI_PATTERN.source, "u");
const graphemes = new Intl.Segmenter("es", { granularity: "grapheme" });

/**
 * El largo de un texto como lo cuenta X (`x.md` §5.4, sin la librería `twitter-text`): cada URL
 * pesa 23 (`X_URL_WEIGHT`), cada emoji (con sus modificadores y uniones) pesa 2, los caracteres
 * latinos (con tildes) pesan 1 y los demás, como los CJK, 2. El texto se normaliza a NFC antes de
 * contar, como hace X.
 */
export function xWeightedLength(text: string): number {
  const normalized = text.normalize("NFC");
  let length = 0;
  let rest = "";
  let last = 0;
  for (const match of normalized.matchAll(linkPattern())) {
    rest += normalized.slice(last, match.index);
    length += X_URL_WEIGHT;
    last = match.index + match[0].length;
  }
  rest += normalized.slice(last);
  for (const { segment } of graphemes.segment(rest)) {
    if (EMOJI.test(segment)) {
      length += 2;
      continue;
    }
    for (const char of segment) length += isLight(char.codePointAt(0) ?? 0) ? 1 : 2;
  }
  return length;
}

/**
 * `@everyone` y `@here` neutralizados para Discord (spec F9 §4.4, `discord.md` §11): un espacio de
 * ancho cero después de la arroba, como hacen los bots de Discord, donde sea que estén (Discord los
 * reconoce también pegados a otra palabra, `a@everyone`). Lo envía así el publisher (F9-T14), y la
 * revisión mide este texto (`postTextLength`), así los dos cuentan lo mismo.
 */
export const neutralizeDiscordMentions = (text: string): string =>
  text.replace(/@(everyone|here)/gi, "@\u200b$1");

/**
 * El largo del texto de un post en una red, como lo cuenta esa red, con los hashtags
 * (`joinedPostText`): X con su conteo ponderado; Discord con `@everyone`/`@here` neutralizados
 * (`neutralizeDiscordMentions`, lo que envía su publisher); LinkedIn **con los escapes** (si su límite cuenta
 * la cadena escapada o la visible no está verificado, `linkedin.md` §5.3: se mide lo más largo);
 * las demás, en unidades de UTF-16 (como `instagramCaption`). Lo usan la revisión y el contador del
 * editor, así no pueden divergir.
 */
export function postTextLength(
  platform: PostPlatform,
  text: { body: string; hashtags: readonly string[] },
): { length: number; max: number } {
  const joined = joinedPostText(text);
  const max = POST_TEXT_LIMITS[platform];
  switch (platform) {
    case "x":
      return { length: xWeightedLength(joined), max };
    case "linkedin":
      return { length: escapeLinkedInText(joined).length, max };
    // Lo que envía el publisher: con las menciones masivas neutralizadas (F9-T14).
    case "discord":
      return { length: neutralizeDiscordMentions(joined).length, max };
    default:
      return { length: joined.length, max };
  }
}

/**
 * Si la red publica un post de ese tipo (F9-T20): Instagram necesita una imagen, un carrusel o un
 * video, y TikTok publica solo video (F9-T26); las demás aceptan todo. Devuelve el motivo, o `null`
 * si sirve. La usan el plan (una red que no sirve se le quita a la idea) y `post.draft` (no redacta
 * para una red que no sirve al tipo del post). Que falte subir el medio lo revisa
 * `checkPostContent` (`MEDIA_REQUIREMENT`), no esto.
 */
export function kindProblem(platform: PostPlatform, kind: PostKind): string | null {
  if (platform === "instagram" && kind === "text")
    return "Instagram necesita una imagen o un video";
  if (platform === "tiktok" && kind !== "video") return "TikTok publica solo video";
  return null;
}
