import type { Broker } from "./broker.js";
import type { Content } from "./content.js";
import type { PostKind } from "./enums.js";
import { AppError } from "./errors.js";
import type { CardSpec } from "./ports/card-renderer.js";
import type { Post } from "./post.js";

// Las tarjetas de la marca de un post (F9.5-T25, ADR-0038 §1.1): qué dice cada una. El texto sale
// del post (su tema y su texto redactado) y de la marca (nombre y contacto), nunca se inventa.

export const POST_CARDS = {
  /** Puntos del texto como mucho: con portada y cierre, 10 tarjetas (el tope de un carrusel). */
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

/** El texto del que salen los puntos: el vigente de la primera red en `SOURCE_ORDER` que tenga. */
export function cardSourceText(contents: readonly Pick<Content, "platform" | "body">[]): string {
  for (const platform of SOURCE_ORDER) {
    const found = contents.find((item) => item.platform === platform && item.body.trim() !== "");
    if (found !== undefined) return found.body;
  }
  return "";
}

/**
 * Los puntos de un texto: sus viñetas («- …», «1. …») si tiene al menos dos; si no, sus párrafos;
 * si es un solo párrafo, sus oraciones. Sin emojis ni hashtags, sin repetir el tema y hasta
 * `POST_CARDS.maxPoints`.
 */
export function cardPoints(body: string, topic: string): string[] {
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
  for (const piece of pieces) {
    const text = cardText(piece);
    if (text.length < POST_CARDS.pointMinChars || text.toLowerCase() === topicKey) continue;
    if (points.includes(text)) continue;
    points.push(clip(text, POST_CARDS.pointMaxChars));
    if (points.length === POST_CARDS.maxPoints) break;
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
 * Las tarjetas de un post según su tipo:
 * - imagen: una, con el tema;
 * - carrusel y video: portada (el tema), una por punto del texto y un cierre (la marca y su
 *   contacto). El video pide al menos `POST_CARDS.videoMinCards` (`POST_IMAGE_NEEDS_TEXT`).
 */
export function postCardDeck(
  post: Pick<Post, "id" | "topic"> & { kind: Exclude<PostKind, "text"> },
  contents: readonly Pick<Content, "platform" | "body">[],
  broker: Pick<Broker, "brandName" | "instagramHandle" | "website">,
): CardSpec[] {
  const cover = clip(cardText(post.topic), POST_CARDS.coverMaxChars);
  if (post.kind === "image") {
    return [{ role: "cover", text: cover, detail: null, position: 1, total: 1 }];
  }
  const points = cardPoints(cardSourceText(contents), post.topic);
  const total = points.length + 2;
  if (post.kind === "video" && total < POST_CARDS.videoMinCards) throw needsText(post.id);
  return [
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
  ];
}
