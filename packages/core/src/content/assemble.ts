import type { Broker } from "../broker.js";
import type { Platform } from "../enums.js";
import { foldText } from "../listing-validator/normalizers.js";
import { formatNumber } from "../price.js";
import type { ContentBrief } from "./brief.js";
import type { ContentDraft } from "./draft.js";

/** Largo máximo del caption de Instagram, con los hashtags (`docs/04-formato-publicaciones.md`). */
export const INSTAGRAM_CAPTION_MAX_LENGTH = 2200;
/** Largo máximo del título de Portal Inmobiliario y Marketplace (Mercado Libre; por confirmar en F4). */
export const LISTING_TITLE_MAX_LENGTH = 60;
/** Cantidad de hashtags del caption: entre 5 y 12. */
export const HASHTAGS_MIN = 5;
export const HASHTAGS_MAX = 12;
/** Un hashtag más largo se descarta: con 12 de este largo, el caption sigue cabiendo. */
const HASHTAG_MAX_LENGTH = 50;

/** El texto de un canal, como se guarda en `contents` (título, cuerpo y hashtags). */
export type AssembledText = { title: string | null; body: string; hashtags: string[] };
export type AssembledContents = Readonly<Record<Platform, AssembledText>>;

/** El contacto que el código agrega a los textos: nunca pasa por la IA. */
export type ContentContact = Pick<Broker, "whatsapp">;

const PROPERTY_EMOJI: Readonly<Record<string, string>> = {
  departamento: "🏢",
  casa: "🏡",
  oficina: "💼",
  "local comercial": "🏪",
  terreno: "🌳",
  parcela: "🌳",
  bodega: "📦",
  estacionamiento: "🚗",
};

const plural = (count: number, singular: string, many: string) =>
  `${formatNumber(count)} ${count === 1 ? singular : many}`;

const positive = (value: number | null): value is number => value !== null && value > 0;

/** `venta` o `arriendo`, en minúscula, para escribirla dentro de una frase. */
const operationWord = (brief: ContentBrief) =>
  brief.operation === null ? null : brief.operation === "sale" ? "venta" : "arriendo";

const propertyType = (brief: ContentBrief) => brief.propertyType ?? "Propiedad";

/** Texto de la IA ya validado: sin espacios de más y con a lo más una línea en blanco seguida. */
const tidy = (text: string) =>
  text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** El caption que se publica: el cuerpo y, después de una línea en blanco, los hashtags. */
export function instagramCaption(text: Pick<AssembledText, "body" | "hashtags">): string {
  return text.hashtags.length === 0 ? text.body : `${text.body}\n\n${text.hashtags.join(" ")}`;
}

/**
 * Hashtag normalizado: `#` y después solo minúsculas sin tildes, números y `_` (`Ñuñoa` →
 * `#nunoa`, `#Plaza Ñuñoa` → `#plazanunoa`). `null` si no queda nada o es demasiado largo.
 */
export function normalizeHashtag(tag: string): string | null {
  const word = foldText(tag).replace(/[^a-z0-9_]/g, "");
  return word === "" || word.length > HASHTAG_MAX_LENGTH ? null : `#${word}`;
}

/**
 * Hashtags del caption: `#{comuna}` y `#{tipo}{operación}`, los fijos del corredor y los de la IA,
 * normalizados y sin repetir; si son menos de 5, se completan con genéricos, y quedan a lo más 12
 * (los de la IA son los primeros en salir).
 */
function buildHashtags(brief: ContentBrief, draft: ContentDraft): string[] {
  const type = propertyType(brief);
  const operation = operationWord(brief) ?? "";
  const candidates = [
    brief.comuna ?? "",
    `${type}${operation}`,
    ...brief.broker.fixedHashtags,
    ...draft.instagram.hashtags,
  ];
  const fallbacks = [type, operation, "propiedades", "bienesraices", "inmobiliaria", "chile"];
  const tags = new Set<string>();
  for (const candidate of candidates) {
    const tag = normalizeHashtag(candidate);
    if (tag !== null) tags.add(tag);
  }
  for (const fallback of fallbacks) {
    if (tags.size >= HASHTAGS_MIN) break;
    const tag = normalizeHashtag(fallback);
    if (tag !== null) tags.add(tag);
  }
  return [...tags].slice(0, HASHTAGS_MAX);
}

/** Recorta un texto a `max` caracteres en un límite de palabra, con `…` al final. */
function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - 1));
  const lastSpace = cut.search(/\s\S*$/);
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** `📐 72,5 m² útiles · 🛏 3 dorm · 🛁 2 baños · 🚗 1 est`, solo con los datos que hay. */
function instagramFactsLine(brief: ContentBrief): string | null {
  const facts = [
    brief.usefulArea === null ? null : `📐 ${formatNumber(brief.usefulArea)} m² útiles`,
    positive(brief.bedrooms) ? `🛏 ${formatNumber(brief.bedrooms)} dorm` : null,
    positive(brief.bathrooms) ? `🛁 ${plural(brief.bathrooms, "baño", "baños")}` : null,
    positive(brief.parking) ? `🚗 ${formatNumber(brief.parking)} est` : null,
  ].filter((fact) => fact !== null);
  return facts.length === 0 ? null : facts.join(" · ");
}

const priceLine = (brief: ContentBrief, separator: string) =>
  brief.commonExpenses === null
    ? brief.price
    : `${brief.price}${separator}GC aprox. ${brief.commonExpenses}`;

/** `Departamento en venta` (o solo el tipo, si el aviso no tiene operación). */
function typeAndOperation(brief: ContentBrief): string {
  const operation = operationWord(brief);
  return operation === null ? propertyType(brief) : `${propertyType(brief)} en ${operation}`;
}

/**
 * Caption de Instagram (`docs/04-formato-publicaciones.md`): tipo y comuna, gancho, datos, precio,
 * el texto de la IA y el contacto; los hashtags van aparte. Si con los hashtags pasa de 2.200
 * caracteres, se recorta el texto de la IA.
 */
function assembleInstagram(
  brief: ContentBrief,
  draft: ContentDraft,
  contact: ContentContact,
): AssembledText {
  const emoji = PROPERTY_EMOJI[foldText(brief.propertyType ?? "")] ?? "🏠";
  const hashtags = buildHashtags(brief, draft);
  const contactLine =
    contact.whatsapp === null
      ? "📩 Escríbeme por DM"
      : `📩 Escríbeme por DM o al WhatsApp ${contact.whatsapp}`;
  const facts = instagramFactsLine(brief);
  const paragraphs = (body: string) =>
    [
      `${emoji} ${[typeAndOperation(brief), brief.comuna].filter((part) => part !== null).join(" · ")}\n${oneLine(draft.instagram.hook)}`,
      [facts, `💰 ${priceLine(brief, " | ")}`].filter((line) => line !== null).join("\n"),
      body,
      contactLine,
    ]
      .filter((paragraph) => paragraph !== "")
      .join("\n\n");

  const body = tidy(draft.instagram.body);
  const full = paragraphs(body);
  const overflow = instagramCaption({ body: full, hashtags }).length - INSTAGRAM_CAPTION_MAX_LENGTH;
  if (overflow <= 0) return { title: null, body: full, hashtags };
  // Lo que sobra sale del texto de la IA; si no alcanza, el párrafo se quita entero.
  const room = body.length - overflow;
  return {
    title: null,
    body: paragraphs(room < 20 ? "" : truncateText(body, room)),
    hashtags,
  };
}

/**
 * Título de Portal y Marketplace (D9): `Departamento en venta 3 dormitorios 2 baños en Ñuñoa`, sin
 * abreviaturas, con singular y plural, y sin dormitorios ni baños si son 0. Si pasa de 60
 * caracteres, se quitan primero los baños y después los dormitorios; si aún no cabe, se recorta.
 */
export function listingTitle(brief: ContentBrief): string {
  const start = typeAndOperation(brief);
  const end = brief.comuna === null ? "" : ` en ${brief.comuna}`;
  const bedrooms = positive(brief.bedrooms)
    ? ` ${plural(brief.bedrooms, "dormitorio", "dormitorios")}`
    : "";
  const bathrooms = positive(brief.bathrooms) ? ` ${plural(brief.bathrooms, "baño", "baños")}` : "";
  const options = [
    `${start}${bedrooms}${bathrooms}${end}`,
    `${start}${bedrooms}${end}`,
    `${start}${end}`,
  ].map((title) => stripEmoji(title));
  const fits = options.find((title) => title.length <= LISTING_TITLE_MAX_LENGTH);
  return fits ?? truncateText(options.at(-1) ?? "", LISTING_TITLE_MAX_LENGTH).replace(/…$/, "");
}

/**
 * Quita los emojis (y sus modificadores) de un texto: Portal Inmobiliario va en texto plano. Los
 * espacios que quedan dobles, antes de un signo o al borde de una línea, se quitan.
 */
export function stripEmoji(text: string): string {
  return text
    .replace(
      /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u{FE0F}|\u{200D}|\u{20E3}/gu,
      "",
    )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .replace(/^[ \t]+/gm, "");
}

/**
 * Descripción de Portal: presentación, `Características:`, `Espacios comunes:`, `Ubicación y
 * conectividad:` y `Condiciones:` (solo las que tienen datos) y un cierre sin teléfono ni email.
 * Texto plano, sin emojis.
 */
function assemblePortal(brief: ContentBrief, draft: ContentDraft): AssembledText {
  const { presentation, location, conditions } = draft.portal_inmobiliario;
  const section = (heading: string, lines: readonly (string | null)[]) => {
    const present = lines.filter((line) => line !== null && line !== "");
    return present.length === 0 ? "" : `${heading}\n${present.join("\n")}`;
  };
  const conditionLines = [
    brief.availability === null ? null : `Disponibilidad: ${brief.availability}.`,
    conditions === null ? null : tidy(conditions),
  ];
  const body = [
    tidy(presentation),
    section(
      "Características:",
      brief.features.map((feature) => `- ${feature.label}: ${feature.value}`),
    ),
    section(
      "Espacios comunes:",
      brief.amenities.map((amenity) => `- ${amenity}`),
    ),
    section("Ubicación y conectividad:", [location === null ? null : tidy(location)]),
    section("Condiciones:", conditionLines),
    "Si te interesa, coordina una visita a través de Portal Inmobiliario.",
  ]
    .filter((paragraph) => paragraph !== "")
    .join("\n\n");
  return { title: listingTitle(brief), body: tidy(stripEmoji(body)), hashtags: [] };
}

/**
 * Descripción de Marketplace: la introducción de la IA, los datos principales, el precio y el
 * WhatsApp, con pocos emojis.
 */
function assembleMarketplace(
  brief: ContentBrief,
  draft: ContentDraft,
  contact: ContentContact,
): AssembledText {
  const place = [typeAndOperation(brief), brief.comuna, brief.sectorReference, brief.address];
  const facts = [
    positive(brief.bedrooms) ? plural(brief.bedrooms, "dormitorio", "dormitorios") : null,
    positive(brief.bathrooms) ? plural(brief.bathrooms, "baño", "baños") : null,
    brief.usefulArea === null ? null : `${formatNumber(brief.usefulArea)} m² útiles`,
    positive(brief.parking) ? plural(brief.parking, "estacionamiento", "estacionamientos") : null,
  ].filter((fact) => fact !== null);
  const data = [
    `🏠 ${place.filter((part) => part !== null).join(" · ")}`,
    facts.length === 0 ? null : facts.join(" · "),
    `💰 ${priceLine(brief, " · ")}`,
    brief.availability === null ? null : `Disponibilidad: ${brief.availability}`,
  ].filter((line) => line !== null);
  const contactLine =
    contact.whatsapp === null
      ? "📲 Escríbeme por Marketplace para coordinar una visita."
      : `📲 Escríbeme al WhatsApp ${contact.whatsapp}`;
  return {
    title: listingTitle(brief),
    body: [tidy(draft.fb_marketplace.intro), data.join("\n"), contactLine].join("\n\n"),
    hashtags: [],
  };
}

/**
 * Los textos de los tres canales a partir del brief, el borrador de la IA y el contacto
 * (ADR-0013, `docs/04-formato-publicaciones.md`). Puro: los datos (precio, superficies,
 * dormitorios, contacto, títulos y hashtags base) los pone el código.
 */
export function assembleContents(
  brief: ContentBrief,
  draft: ContentDraft,
  contact: ContentContact,
): AssembledContents {
  return {
    instagram: assembleInstagram(brief, draft, contact),
    portal_inmobiliario: assemblePortal(brief, draft),
    fb_marketplace: assembleMarketplace(brief, draft, contact),
  };
}
