import type { Broker } from "../broker.js";
import {
  CONTENT_CHECK_SEVERITIES,
  type ContentCheck,
  type ContentCheckCode,
} from "../content/check.js";
import type { EditorialProfileView } from "../editorial-profile.js";
import type { PostKind, PostPlatform } from "../enums.js";
import { foldText } from "../listing-validator/normalizers.js";
import type { Media } from "../media.js";
import type { Post } from "../post.js";
import { operatorBriefOf, xLinksOf } from "./brief.js";
import {
  DISCORD_MAX_FILES,
  INSTAGRAM_HASHTAGS_LIMIT,
  linkKey,
  linkPattern,
  linksIn,
  postTextLength,
  X_LINK_POST_COST_USD,
  X_MAX_IMAGES,
  X_POST_COST_USD,
} from "./networks.js";

// La revisión de los textos de un post (spec F9 §4.4, ADR-0030 punto 7): una función pura que
// corre sobre el texto final, también después de una edición manual, y no se guarda (se calcula
// al leer y al aprobar). Los errores impiden aprobar; las advertencias, no.

/**
 * Lo que la revisión necesita de un post: lo que lleva (`kind` y sus medios), las **fuentes de
 * hechos** (el perfil editorial de su marca, y el brief y el tema solo si los escribió el
 * operador), los enlaces que el operador marcó para X y lo que el perfil pide evitar.
 */
export type PostCheckContext = {
  kind: PostKind;
  /** Los originales del post: cuántas imágenes y videos subió el operador. */
  media: { images: number; videos: number };
  /** Todo el texto que es fuente de hechos, junto (ver `buildPostCheckContext`). */
  sources: string;
  /** Los enlaces del brief del operador (`linkKey`): los únicos permitidos en X. */
  xLinks: string[];
  avoid: string[];
};

/**
 * El contexto de la revisión de un post. Fuentes de hechos (ADR-0030, punto 1): el nombre de la
 * marca, los `facts`, el público, las líneas de contenido y los hashtags del perfil y del corredor;
 * el brief del post solo con `briefOrigin = operator`, y el tema solo en un post manual (el tema
 * de una idea lo escribió la IA). `avoid` no es fuente: es lo que no se usa. Nada de otra marca.
 */
export function buildPostCheckContext(params: {
  post: Pick<Post, "kind" | "topic" | "brief" | "briefOrigin" | "source">;
  profile: Pick<
    EditorialProfileView,
    "facts" | "audience" | "pillars" | "defaultHashtags" | "avoid"
  >;
  broker: Pick<Broker, "brandName" | "fixedHashtags">;
  media: readonly Pick<Media, "role" | "kind">[];
}): PostCheckContext {
  const { post, profile, broker } = params;
  const originals = params.media.filter((item) => item.role === "original");
  const sources = [
    broker.brandName,
    ...profile.facts,
    profile.audience ?? "",
    ...profile.pillars.flatMap((pillar) => [pillar.name, pillar.description]),
    ...profile.defaultHashtags,
    ...broker.fixedHashtags,
    operatorBriefOf(post) ?? "",
    post.source === "manual" ? post.topic : "",
  ]
    .filter((text) => text.trim() !== "")
    .join("\n");
  return {
    kind: post.kind,
    media: {
      images: originals.filter((item) => item.kind === "image").length,
      videos: originals.filter((item) => item.kind === "video").length,
    },
    sources,
    xLinks: xLinksOf(post),
    avoid: [...profile.avoid],
  };
}

/** Una mención (`@algo`) que no es parte de un correo ni de una palabra. */
const MENTION = /(?<![\p{L}\p{N}_.@])@([\p{L}\p{N}_.]*[\p{L}\p{N}_])/gu;

/** Un hashtag dentro del texto. */
const HASHTAG_IN_TEXT = /(?<![\p{L}\p{N}_])#[\p{L}\p{N}_]+/gu;

/**
 * Una cifra: dígitos con separadores de miles o decimales (`5.800`, `72,5`, `2026`, `1,000`), que
 * no siguen a una letra (`B2B` y `web3` son nombres, no cifras). Se comparan sin los separadores
 * (`numberKey`), así `1.000` y `1,000` son la misma en los dos idiomas.
 */
const NUMBER = /(?<![\p{L}\p{N}.,])\d+(?:[.,]\d+)*/gu;

/** La forma comparable de una cifra: solo los dígitos, sin ceros a la izquierda. */
const numberKey = (raw: string) => raw.replace(/[.,]/g, "").replace(/^0+(?=\d)/, "");

/** Una palabra: letras y números, empezando por letra (`AgentPey`, `B2B`, `iPhone`). */
const WORD = /\p{L}[\p{L}\p{N}]*/gu;

/** Fin de frase: `.`, `!`, `?`, `…`, `:` o `;` seguidos de espacio. */
const SENTENCE_BREAK = /(?<=[.!?…:;])\s+/u;

/** Lo que abre una frase o una cita: la palabra que viene después va con mayúscula sin ser un nombre. */
const OPENERS = new Set(["¿", "¡", '"', "«", "“", "'", "‘"]);

/**
 * Palabras que se escriben con mayúscula y no son un hecho de la marca: las redes donde se
 * publica, los días y meses (en inglés van con mayúscula), los idiomas en inglés, el pronombre
 * `I` y siglas comunes. Plegadas (sin tildes, en minúsculas).
 */
const COMMON_CAPITALIZED: ReadonlySet<string> = new Set([
  "instagram",
  "linkedin",
  "discord",
  "tiktok",
  "x",
  "i",
  "ia",
  "ai",
  "ok",
  "api",
  "apis",
  "ceo",
  "cto",
  "crm",
  "faq",
  "pdf",
  "url",
  "uf",
  "b2b",
  "b2c",
  "saas",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "lunes",
  "martes",
  "miercoles",
  "jueves",
  "viernes",
  "sabado",
  "domingo",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
  "english",
  "spanish",
]);

/** `true` si la palabra lleva alguna mayúscula (`Banco`, `AgentPey`, `iPhone`, `CEO`). */
const hasUppercase = (word: string) => /\p{Lu}/u.test(word);

const foldedWords = (text: string) => new Set(foldText(text).match(/[\p{L}\p{N}]+/gu) ?? []);

/**
 * Los posibles nombres propios de un texto que no están en las fuentes (heurística, spec F9 §4.4):
 * una palabra con mayúscula que **no** abre una frase (ni una línea, ni va tras `¿`, `¡` o una
 * comilla), que no está entre las palabras de las fuentes ni en `COMMON_CAPITALIZED`. Las que van
 * seguidas se juntan (`Banco Central`). No ve un nombre escrito en minúsculas ni los que abren una
 * frase: la regla de hechos del prompt es la primera barrera y el operador revisa cada texto.
 */
function unknownNames(text: string, sourceWords: ReadonlySet<string>): string[] {
  const names: string[] = [];
  for (const line of text.split("\n")) {
    for (const sentence of line.split(SENTENCE_BREAK)) {
      let run: { text: string; end: number } | null = null;
      let first = true;
      for (const match of sentence.matchAll(WORD)) {
        const word = match[0];
        const start = match.index;
        const before = sentence.slice(0, start).trimEnd();
        const opener = first || OPENERS.has(before.at(-1) ?? "");
        first = false;
        const folded = foldText(word);
        const unknown =
          !opener &&
          hasUppercase(word) &&
          !sourceWords.has(folded) &&
          !COMMON_CAPITALIZED.has(folded);
        if (!unknown) {
          if (run !== null) names.push(run.text);
          run = null;
          continue;
        }
        if (run !== null && /^\s+$/u.test(sentence.slice(run.end, start))) {
          run = { text: `${run.text} ${word}`, end: start + word.length };
        } else {
          if (run !== null) names.push(run.text);
          run = { text: word, end: start + word.length };
        }
      }
      if (run !== null) names.push(run.text);
    }
  }
  return [...new Set(names)];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** El nombre de cada red, para los mensajes. */
const PLATFORM_NAME: Readonly<Record<PostPlatform, string>> = {
  instagram: "Instagram",
  x: "X",
  linkedin: "LinkedIn",
  discord: "Discord",
  tiktok: "TikTok",
};

const usd = (value: number) => `US$${value.toFixed(value < 0.1 ? 3 : 2).replace(".", ",")}`;

/** El mensaje de `TOO_LONG`, con cómo cuenta la red. */
function tooLongMessage(platform: PostPlatform, length: number, max: number): string {
  if (platform === "x") {
    return `El texto tiene ${length} caracteres ponderados con los hashtags (máximo ${max}; un enlace cuenta 23 y un emoji, 2)`;
  }
  if (platform === "linkedin") {
    return `El texto tiene ${length} caracteres con los hashtags y los escapes de LinkedIn (máximo ${max})`;
  }
  return `El texto tiene ${length} caracteres con los hashtags (máximo ${max})`;
}

/** Los requisitos de medios de cada red (spec F9 §4.4 y §4.6): el mensaje, o `null` si cumple. */
function mediaProblem(platform: PostPlatform, ctx: PostCheckContext): string | null {
  const { kind, media } = ctx;
  if (kind === "video") {
    return media.videos === 0
      ? "El post es de video y no tiene video: súbelo o cambia el tipo del post"
      : null;
  }
  if (platform === "tiktok") return "TikTok publica solo video: cambia el post a video y súbelo";
  if (kind === "text") {
    return platform === "instagram"
      ? "Instagram necesita una imagen o un video: súbelos y cambia el tipo del post"
      : null;
  }
  if (media.images === 0) return "El post es de imágenes y no tiene ninguna: súbelas";
  if (platform === "x" && media.images > X_MAX_IMAGES) {
    return `X admite hasta ${X_MAX_IMAGES} imágenes o 1 video por post, y este tiene ${media.images} imágenes`;
  }
  if (platform === "discord" && media.images > DISCORD_MAX_FILES) {
    return `Discord admite hasta ${DISCORD_MAX_FILES} archivos por mensaje, y este tiene ${media.images} imágenes`;
  }
  return null;
}

/**
 * Revisa el texto de un post en una red (spec F9 §4.4). Errores (impiden aprobar):
 * - `TOO_LONG`: el largo de la red con los hashtags (`postTextLength`: X ponderado, LinkedIn con
 *   los escapes);
 * - `HASHTAG_LIMIT`: más de 30 hashtags en Instagram;
 * - `MASS_MENTION`: `@everyone` o `@here`, en cualquier red;
 * - `FACT_NOT_IN_PROFILE`: una cifra, un posible nombre propio, un enlace o una mención que no
 *   están en las fuentes de hechos (`buildPostCheckContext`; un brief de la IA no cuenta);
 * - `LINK_NOT_ALLOWED`: en X, un enlace que el operador no puso en el brief del post;
 * - `MEDIA_REQUIREMENT`: un video sin video, Instagram sin imagen ni video, TikTok sin video, X
 *   con más de 4 imágenes, Discord con más de 10.
 * Advertencias: `LINK_COST` (X con un enlace: US$0,20 en vez de US$0,015), `AVOID_TERM` (algo de
 * lo que el perfil pide evitar) y `MARKDOWN` (salvo en Discord, que lo muestra).
 */
export function checkPostContent(
  platform: PostPlatform,
  text: { body: string; hashtags: readonly string[] },
  ctx: PostCheckContext,
): ContentCheck[] {
  const checks: ContentCheck[] = [];
  const add = (code: ContentCheckCode, message: string) =>
    checks.push({ code, severity: CONTENT_CHECK_SEVERITIES[code], message });
  const name = PLATFORM_NAME[platform];

  const { length, max } = postTextLength(platform, text);
  if (length > max) add("TOO_LONG", tooLongMessage(platform, length, max));

  if (platform === "instagram") {
    const count = text.hashtags.length + (text.body.match(HASHTAG_IN_TEXT) ?? []).length;
    if (count > INSTAGRAM_HASHTAGS_LIMIT) {
      add(
        "HASHTAG_LIMIT",
        `Tiene ${count} hashtags: Instagram admite hasta ${INSTAGRAM_HASHTAGS_LIMIT}`,
      );
    }
  }

  // Menciones: las masivas nunca; las demás, solo si están en las fuentes.
  const sourceMentions = new Set(
    [...ctx.sources.matchAll(MENTION)].map((match) => (match[1] ?? "").toLowerCase()),
  );
  const mentions = [...text.body.matchAll(MENTION)].map((match) => match[1] ?? "");
  if (mentions.some((mention) => ["everyone", "here"].includes(mention.toLowerCase()))) {
    add("MASS_MENTION", "Tiene @everyone o @here: avisaría a todo un servidor o canal");
  }
  for (const mention of new Set(mentions)) {
    const key = mention.toLowerCase();
    if (key === "everyone" || key === "here" || sourceMentions.has(key)) continue;
    add(
      "FACT_NOT_IN_PROFILE",
      `La mención «@${mention}» no está en el perfil ni en el brief del operador`,
    );
  }

  // Enlaces: solo los de las fuentes; en X, además, solo los que el operador marcó en el brief.
  const sourceLinks = new Set(linksIn(ctx.sources).map(linkKey));
  const links = [...new Set(linksIn(text.body))];
  for (const link of links) {
    if (!sourceLinks.has(linkKey(link))) {
      add(
        "FACT_NOT_IN_PROFILE",
        `El enlace «${link}» no está en el perfil ni en el brief del operador`,
      );
    } else if (platform === "x" && !ctx.xLinks.includes(linkKey(link))) {
      add(
        "LINK_NOT_ALLOWED",
        `En X, un enlace va solo si lo pones en el brief del post (cuesta ${usd(X_LINK_POST_COST_USD)}): «${link}»`,
      );
    }
  }
  if (platform === "x" && links.length > 0) {
    add(
      "LINK_COST",
      `Este post de X lleva un enlace: cuesta ${usd(X_LINK_POST_COST_USD)} en vez de ${usd(X_POST_COST_USD)}`,
    );
  }

  // Cifras y nombres propios, fuera de enlaces, menciones y hashtags del texto.
  const prose = text.body
    .replace(linkPattern(), " ")
    .replace(MENTION, " ")
    .replace(HASHTAG_IN_TEXT, " ");
  const sourceNumbers = new Set((ctx.sources.match(NUMBER) ?? []).map(numberKey));
  const reported = new Set<string>();
  for (const raw of [prose, ...text.hashtags].join("\n").match(NUMBER) ?? []) {
    const key = numberKey(raw);
    if (sourceNumbers.has(key) || reported.has(key)) continue;
    reported.add(key);
    add(
      "FACT_NOT_IN_PROFILE",
      `La cifra «${raw}» no está en los hechos del perfil ni en el brief del operador`,
    );
  }
  for (const found of unknownNames(prose, foldedWords(ctx.sources))) {
    add(
      "FACT_NOT_IN_PROFILE",
      `«${found}» parece un nombre propio que no está en el perfil ni en el brief del operador`,
    );
  }

  const problem = mediaProblem(platform, ctx);
  if (problem !== null) add("MEDIA_REQUIREMENT", problem);

  const folded = foldText([text.body, ...text.hashtags].join("\n"));
  for (const term of ctx.avoid) {
    const key = foldText(term);
    if (key === "") continue;
    const pattern = new RegExp(
      String.raw`(?<![\p{L}\p{N}])${escapeRegExp(key)}(?![\p{L}\p{N}])`,
      "u",
    );
    if (pattern.test(folded)) add("AVOID_TERM", `Usa «${term}», que el perfil pide evitar`);
  }

  if (platform !== "discord" && /\*\*|__|^#{1,6}\s|\[[^\]]*\]\([^)]*\)/m.test(text.body)) {
    add("MARKDOWN", `Tiene formato markdown (**, encabezados o links), que ${name} no muestra`);
  }

  return checks;
}
