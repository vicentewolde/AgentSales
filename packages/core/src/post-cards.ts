import type { Broker } from "./broker.js";
import { CAROUSEL_MAX_ITEMS } from "./content/compose.js";
import type { Content } from "./content.js";
import {
  isPostPlatform,
  type Language,
  POST_PLATFORMS,
  type PostKind,
  type PostPlatform,
} from "./enums.js";
import { AppError } from "./errors.js";
import { LANGUAGE_TEXT } from "./labels.js";
import type { CardSpec } from "./ports/card-renderer.js";
import type { Post } from "./post.js";
import { DISCORD_MAX_FILES, kindProblem, X_MAX_IMAGES } from "./social/networks.js";

// Las tarjetas de la marca de un post (F9.5-T25, ADR-0038 §1.1): qué dice cada una. El texto sale
// del post (su tema y su texto redactado) y de la marca (nombre y contacto), nunca se inventa.

export const POST_CARDS = {
  /**
   * Puntos del texto como mucho: con portada y cierre, 10 tarjetas (el tope de un carrusel). Cada
   * red del post puede bajarlo (`cardImageLimit`).
   */
  maxPoints: 8,
  /** Largo de un punto y de la portada; lo que pasa se corta en una palabra con «…». */
  pointMaxChars: 180,
  coverMaxChars: 120,
  /** Un punto más corto que esto no es un punto («Sí.»). */
  pointMinChars: 4,
  /** El video de las tarjetas pide al menos 3 (`REEL_PHOTOS.min`). */
  videoMinCards: 3,
} as const;

/** El orden en que se elige el texto del que salen los puntos (el más largo y libre primero). */
const SOURCE_ORDER = ["instagram", "linkedin", "tiktok", "discord", "x"] as const;

// Emojis y sus uniones: Inter no los tiene (saldrían como cuadros).
const PICTOGRAPHS = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\u{FE0F}|\u{200D}|\u{20E3}/gu;
const HASHTAG = /(^|\s)#[\p{L}\p{N}_]+/gu;
const BULLET = /^\s*(?:[-–—•*·▪►✓✔→]|\d{1,2}[.)])\s+/u;

/** Un texto limpio para una tarjeta: sin emojis, sin hashtags y con los espacios normales. */
export function cardText(text: string): string {
  return text.replace(PICTOGRAPHS, "").replace(HASHTAG, "$1").replace(/\s+/gu, " ").trim();
}

/** Corta en una palabra y agrega «…» si el texto pasa de `max`. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/u, "")}…`;
}

/**
 * El texto del que salen los puntos, **de un solo idioma** (arreglo de las 10 tarjetas con los
 * cuatro textos juntos): el vigente de la primera red en `SOURCE_ORDER` que tenga texto en
 * `language` (el idioma principal de la marca). Si ese idioma no tiene ningún texto, el del primer
 * idioma que sí lo tenga, también de una sola red: nunca se juntan dos textos ni dos idiomas. Sin
 * `language`, el del primero que aparezca. Con `exact`, solo el de `language` (las tarjetas de un
 * idioma no usan el texto de otro). Sin texto, `body = ""`.
 */
export function cardSource(
  contents: readonly Pick<Content, "platform" | "language" | "body">[],
  language?: Language,
  exact = false,
): { body: string; platform: PostPlatform | null; language: Language | null } {
  const filled = contents.filter((item) => item.body.trim() !== "");
  // `exact`: solo el idioma pedido (tarjetas de un idioma: nunca se usa el texto de otro).
  const languages =
    exact && language !== undefined
      ? [language]
      : [
          ...(language === undefined ? [] : [language]),
          ...filled.map((item) => item.language),
        ].filter((value, index, all) => all.indexOf(value) === index);
  for (const wanted of languages) {
    for (const platform of SOURCE_ORDER) {
      const found = filled.find((item) => item.platform === platform && item.language === wanted);
      if (found !== undefined) return { body: found.body, platform, language: wanted };
    }
  }
  return { body: "", platform: null, language: null };
}

/** Solo el texto de `cardSource`. */
export const cardSourceText = (
  contents: readonly Pick<Content, "platform" | "language" | "body">[],
  language?: Language,
): string => cardSource(contents, language).body;

/**
 * Los puntos de un texto: sus viñetas («- …», «1. …») si tiene al menos dos; si no, sus párrafos;
 * si es un solo párrafo, sus oraciones. Sin emojis ni hashtags, sin repetir el tema y hasta
 * `maxPoints` (y nunca más de `POST_CARDS.maxPoints`).
 */
export function cardPoints(
  body: string,
  topic: string,
  maxPoints: number = POST_CARDS.maxPoints,
): string[] {
  const lines = body.split(/\r?\n/u);
  const bullets = lines.filter((line) => BULLET.test(line)).map((line) => line.replace(BULLET, ""));
  let pieces: string[];
  if (bullets.length >= 2) pieces = bullets;
  else {
    const paragraphs = body.split(/\n\s*\n/u).map((part) => part.replace(/\n/gu, " "));
    const clean = paragraphs.filter((part) => cardText(part).length >= POST_CARDS.pointMinChars);
    pieces = clean.length >= 2 ? clean : body.split(/(?<=[.!?])\s+/u);
  }
  const topicKey = cardText(topic).toLowerCase();
  const points: string[] = [];
  const cap = Math.min(maxPoints, POST_CARDS.maxPoints);
  if (cap <= 0) return points;
  for (const piece of pieces) {
    const text = cardText(piece);
    if (text.length < POST_CARDS.pointMinChars || text.toLowerCase() === topicKey) continue;
    if (points.includes(text)) continue;
    points.push(clip(text, POST_CARDS.pointMaxChars));
    if (points.length >= cap) break;
  }
  return points;
}

/** El contacto de la marca para el cierre: su cuenta de Instagram o su sitio, si tiene. */
function brandContact(broker: Pick<Broker, "instagramHandle" | "website">): string | null {
  const handle = broker.instagramHandle?.trim().replace(/^@/u, "");
  if (handle !== undefined && handle !== "") return `@${handle}`;
  const site = broker.website
    ?.trim()
    .replace(/^https?:\/\//u, "")
    .replace(/\/$/u, "");
  return site === undefined || site === "" ? null : site;
}

/** `POST_IMAGE_NEEDS_TEXT` (409): el video de las tarjetas necesita puntos del texto. */
const needsText = (postId: string) =>
  new AppError(
    "POST_IMAGE_NEEDS_TEXT",
    "Para el video de las tarjetas, el post necesita su texto redactado (al menos un punto): pide los textos y vuelve a intentarlo",
    { details: { postId } },
  );

/**
 * Cuántas imágenes admite una red en un post de ese tipo, o `null` si no pone tope. Los números
 * salen de las reglas de cada red (`social/networks.ts` y `content/compose.ts`), las mismas de la
 * revisión (`MEDIA_NOT_SUPPORTED`): aquí no se repiten. Solo cuenta en un carrusel: una imagen
 * suelta es una tarjeta y un video es un solo archivo.
 */
export function platformImageLimit(platform: PostPlatform, kind: PostKind): number | null {
  if (kind !== "carousel") return null;
  if (platform === "x") return X_MAX_IMAGES;
  if (platform === "discord") return DISCORD_MAX_FILES;
  if (platform === "instagram") return CAROUSEL_MAX_ITEMS;
  return null;
}

/** Por qué una red pone su tope, en simple (para el panel). */
const images = (n: number) => (n === 1 ? "1 imagen" : `${n} imágenes`);
const LIMIT_REASON: Readonly<Record<PostPlatform, (max: number) => string>> = {
  instagram: (max) => `Instagram admite hasta ${images(max)} en un carrusel`,
  x: (max) => `X admite hasta ${images(max)} por post`,
  linkedin: (max) => `LinkedIn admite hasta ${images(max)} por post`,
  discord: (max) =>
    `Discord admite hasta ${max === 1 ? "1 archivo" : `${max} archivos`} por mensaje`,
  tiktok: (max) => `TikTok admite hasta ${images(max)} por post`,
};

export type CardImageLimit = {
  /** Cuántas tarjetas como mucho (la regla más estricta de las redes del post). */
  max: number;
  /** La red que pone ese tope; `null` si ninguna red del post lo pone. */
  platform: PostPlatform | null;
};

/**
 * El tope de tarjetas de un post: el límite **más estricto** de sus redes (`platformImageLimit`),
 * sin pasar de `POST_CARDS.maxPoints + 2`. Sin redes con tope, el máximo general (10) y sin red.
 */
export function cardImageLimit(kind: PostKind, platforms: readonly PostPlatform[]): CardImageLimit {
  const general = POST_CARDS.maxPoints + 2;
  let best: CardImageLimit = { max: general, platform: null };
  for (const platform of POST_PLATFORMS) {
    if (!platforms.includes(platform)) continue;
    const limit = platformImageLimit(platform, kind);
    if (limit === null) continue;
    // Gana el límite menor; con un empate, la primera red.
    if (limit < best.max || (best.platform === null && limit === best.max)) {
      best = { max: Math.min(limit, general), platform };
    }
  }
  return best;
}

/**
 * Las redes del post a las que sirven sus tarjetas: con redes fijadas (`platforms`), todas las que
 * sirven al tipo del post, tengan texto o no; sin ellas (`null`, todas las de la marca), las que ya
 * tienen texto vigente. Solo las que sirven al tipo (`kindProblem`), como al redactar.
 */
export function cardPlatforms(
  post: Pick<Post, "kind"> & { platforms?: Post["platforms"] },
  contents: readonly Pick<Content, "platform" | "body">[],
): PostPlatform[] {
  const serves = (platform: PostPlatform) =>
    ((post.platforms ?? null) === null || post.platforms?.includes(platform) === true) &&
    kindProblem(platform, post.kind) === null;
  // Con redes fijadas cuentan todas las que sirven al tipo, tengan texto o no: el texto de una
  // puede llegar después y el tope es el de la red más estricta.
  if (post.platforms != null) return POST_PLATFORMS.filter(serves);
  return POST_PLATFORMS.filter(
    (platform) =>
      serves(platform) &&
      contents.some((item) => item.platform === platform && item.body.trim() !== ""),
  );
}

/** Lo que saldría al pedir tarjetas: el mazo y por qué tiene ese largo. */
export type CardPlan = {
  cards: CardSpec[];
  /** Cuántas tarjetas son un punto del texto. */
  points: number;
  limit: CardImageLimit;
  /** El texto del que salen los puntos: su red e idioma; `null` sin texto o en una imagen sola. */
  source: { platform: PostPlatform; language: Language } | null;
  /** Había más puntos en el texto que los que caben en el tope. */
  limited: boolean;
};

export type CardPlanOptions = {
  /**
   * El idioma de las tarjetas (F9.5, arreglo del idioma): los puntos y el título de la portada salen
   * del texto de **este** idioma, nunca del de otro ni del tema del post (que puede estar en otro
   * idioma). Sin él (los pedidos anteriores), el texto del primer idioma que haya y el tema.
   */
  language?: Language;
};

type PlanPost = Pick<Post, "id" | "topic"> & {
  kind: Exclude<PostKind, "text">;
  /** Las redes que fijó el post; `null` o sin decir, todas las de la marca. */
  platforms?: Post["platforms"];
};
type PlanContent = Pick<Content, "platform" | "language" | "body">;
type PlanBroker = Pick<Broker, "brandName" | "instagramHandle" | "website">;

/**
 * El título de una portada sacado de un texto: su primera oración (sin emojis, hashtags ni el punto
 * final), y el resto del texto, para que esa oración no se repita como primer punto. `null` si el
 * texto empieza con una viñeta o no tiene una primera línea con palabras: ahí no hay título.
 */
export function coverFromText(body: string): { cover: string; rest: string } | null {
  const lines = body.split(/\r?\n/u);
  const index = lines.findIndex((line) => cardText(line) !== "");
  const line = lines[index];
  if (index < 0 || line === undefined || BULLET.test(line)) return null;
  const sentences = line.trim().split(/(?<=[.!?])\s+/u);
  const first = cardText(sentences[0] ?? "")
    .replace(/[.:;,\s]+$/u, "")
    .trim();
  if (first.length < POST_CARDS.pointMinChars) return null;
  const remainder = sentences.slice(1).join(" ");
  return {
    cover: clip(first, POST_CARDS.coverMaxChars),
    rest: [remainder, ...lines.slice(index + 1)].join("\n"),
  };
}

/**
 * El plan de tarjetas de un post según su tipo:
 * - imagen: una, con el tema;
 * - carrusel: portada (el tema), una por punto del texto y un cierre (la marca y su contacto), sin
 *   pasar del tope más estricto de las redes del post (`cardImageLimit`: X, 4; Instagram y Discord,
 *   10). Con un tope de 1, solo la portada; de 2, portada y cierre;
 * - video: lo mismo sin el tope de imágenes (el video es un solo archivo), con al menos
 *   `POST_CARDS.videoMinCards` (`POST_IMAGE_NEEDS_TEXT`).
 * Los puntos salen de **un solo texto** (`cardSource`) y, con `options.language`, de un solo idioma:
 * el título de la portada también sale de ese texto (su primera oración), no del tema del post.
 */
export function postCardPlan(
  post: PlanPost,
  contents: readonly PlanContent[],
  broker: PlanBroker,
  options: CardPlanOptions = {},
): CardPlan {
  const topicCover = clip(cardText(post.topic), POST_CARDS.coverMaxChars);
  const usable = contents.filter(
    (item) =>
      isPostPlatform(item.platform) &&
      ((post.platforms ?? null) === null || post.platforms?.includes(item.platform) === true) &&
      kindProblem(item.platform, post.kind) === null,
  );
  const limit = cardImageLimit(post.kind, cardPlatforms(post, usable));
  const source = cardSource(usable, options.language, options.language !== undefined);
  const sourceInfo =
    source.platform === null || source.language === null
      ? null
      : { platform: source.platform, language: source.language };
  // Con un idioma pedido, la portada sale del texto de ese idioma (no del tema, que puede estar en
  // otro idioma); sin texto o sin una primera oración, del tema.
  const headline = options.language === undefined ? null : coverFromText(source.body);
  const cover = headline?.cover ?? topicCover;
  const single: CardSpec[] = [{ role: "cover", text: cover, detail: null, position: 1, total: 1 }];
  if (post.kind === "image") {
    return {
      cards: single,
      points: 0,
      limit,
      source: headline === null ? null : sourceInfo,
      limited: false,
    };
  }
  const available = cardPoints(headline?.rest ?? source.body, cover);
  if (post.kind === "carousel" && limit.max < 2) {
    return { cards: single, points: 0, limit, source: sourceInfo, limited: available.length > 0 };
  }
  const room = post.kind === "video" ? POST_CARDS.maxPoints : limit.max - 2;
  const points = available.slice(0, room);
  const total = points.length + 2;
  if (post.kind === "video" && total < POST_CARDS.videoMinCards) throw needsText(post.id);
  return {
    cards: [
      { role: "cover", text: cover, detail: null, position: 1, total },
      ...points.map((text, index) => ({
        role: "point" as const,
        text,
        detail: null,
        position: index + 2,
        total,
      })),
      {
        role: "closing",
        text: broker.brandName,
        detail: brandContact(broker),
        position: total,
        total,
      },
    ],
    points: points.length,
    limit,
    source: sourceInfo,
    limited: available.length > points.length,
  };
}

/** Las tarjetas de `postCardPlan` (el mazo que dibuja el worker). */
export const postCardDeck = (
  post: PlanPost,
  contents: readonly PlanContent[],
  broker: PlanBroker,
  options: CardPlanOptions = {},
): CardSpec[] => postCardPlan(post, contents, broker, options).cards;

/**
 * Lo que el panel dice antes de hacer las tarjetas: cuántas saldrán y por qué, en simple. Por
 * ejemplo «4 tarjetas: X admite hasta 4 imágenes por post (portada, 2 puntos y cierre, del texto en
 * español)».
 */
export function describeCardPlan(
  plan: Pick<CardPlan, "cards" | "points" | "limit" | "source" | "limited">,
  kind: Exclude<PostKind, "text">,
): string {
  if (kind === "image") {
    return plan.source === null
      ? "1 tarjeta con el tema del post."
      : `1 tarjeta con la primera frase del texto en ${LANGUAGE_TEXT[plan.source.language]}.`;
  }
  const count = plan.cards.length;
  const noun = count === 1 ? "1 tarjeta" : `${count} tarjetas`;
  const parts =
    count === 1
      ? "solo la portada"
      : plan.points === 0
        ? "portada y cierre"
        : `portada, ${plan.points === 1 ? "1 punto" : `${plan.points} puntos`} y cierre`;
  const language =
    plan.source === null ? "" : `, del texto en ${LANGUAGE_TEXT[plan.source.language]}`;
  const why =
    kind === "carousel" &&
    plan.limit.platform !== null &&
    (plan.limited || count === plan.limit.max)
      ? `${LIMIT_REASON[plan.limit.platform](plan.limit.max)}; `
      : "";
  return `${noun}: ${why}${parts}${language}.`;
}
