import type { Broker } from "../broker.js";
import type { Platform } from "../enums.js";
import type { FieldDefinition } from "../field-definition.js";
import type { Listing } from "../listing.js";
import { foldText } from "../listing-validator/normalizers.js";
import {
  type AssembledText,
  type ContentContact,
  HASHTAGS_MAX,
  HASHTAGS_MIN,
  hasEmoji,
  INSTAGRAM_CAPTION_MAX_LENGTH,
  instagramCaption,
  LISTING_TITLE_MAX_LENGTH,
} from "./assemble.js";
import { buildContentBrief, type ContentBrief } from "./brief.js";
import { AMENITY_TERMS, DISCRIMINATORY_PATTERNS, SUPERLATIVE_TERMS } from "./check-terms.js";

/** Códigos de la revisión editorial (spec F2 §4.6), con su severidad. */
export const CONTENT_CHECK_SEVERITIES = {
  NUMBER_NOT_IN_DATA: "error",
  ADDRESS_EXPOSED: "error",
  INTERNAL_NOTES_LEAK: "error",
  DISCRIMINATORY: "error",
  EMOJI_NOT_ALLOWED: "error",
  TOO_LONG: "error",
  AMENITY_NOT_IN_DATA: "warning",
  SUPERLATIVE: "warning",
  MARKDOWN: "warning",
  HASHTAG_COUNT: "warning",
} as const;
export type ContentCheckCode = keyof typeof CONTENT_CHECK_SEVERITIES;
export type ContentCheckSeverity = (typeof CONTENT_CHECK_SEVERITIES)[ContentCheckCode];

/** Un problema del texto: los errores bloquean (`eval:content` sale con 1), las advertencias no. */
export type ContentCheck = {
  code: ContentCheckCode;
  severity: ContentCheckSeverity;
  message: string;
};

/**
 * Lo que la revisión necesita: el brief (los datos permitidos), el contacto que pone el código y lo
 * **privado** del aviso, que nunca va a la IA pero sirve para detectar una fuga (por ejemplo, en
 * una edición manual).
 */
export type ContentCheckContext = {
  brief: ContentBrief;
  contact: ContentContact;
  private: { address: string | null; unitNumber: string | null; internalNotes: string | null };
};

/** El contexto de la revisión de un aviso, con el mismo brief que ve la IA. */
export function buildContentCheckContext(
  listing: Listing,
  definitions: readonly FieldDefinition[],
  broker: Pick<Broker, "brandName" | "tone" | "fixedHashtags" | "whatsapp">,
): ContentCheckContext {
  return {
    brief: buildContentBrief(listing, definitions, broker),
    contact: { whatsapp: broker.whatsapp },
    private: {
      address: listing.address,
      unitNumber: listing.unitNumber,
      internalNotes: listing.internalNotes,
    },
  };
}

/**
 * Un número escrito con formato chileno (`5.800`, `72,5`, `2018`) o suelto (`5800`). Los grupos
 * de miles con punto van primero, para que `5.800` sea un número y no `5` y `800`.
 */
const NUMBER = /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g;

/** Valor canónico de un número del texto: `5.800` y `5800` → `5800`; `72,5` → `72.5`. */
const numberKey = (text: string) => String(Number(text.replace(/\./g, "").replace(",", ".")));

const numbersIn = (text: string) =>
  (text.match(NUMBER) ?? []).map((raw) => ({ raw, key: numberKey(raw) }));

/** Todos los textos y números del brief: los datos que el aviso sí entrega. */
function briefValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number") return [String(value).replace(".", ",")];
  if (Array.isArray(value)) return value.flatMap(briefValues);
  if (typeof value === "object") return Object.values(value).flatMap(briefValues);
  return [];
}

/** Términos de una lista que aparecen como palabra (o con su plural simple) en un texto plegado. */
function termsIn(folded: string, terms: readonly string[]): string[] {
  return terms.filter((term) => new RegExp(String.raw`\b${term}(?:s|es)?\b`).test(folded));
}

const words = (text: string) => foldText(text).match(/[a-z0-9]+/g) ?? [];

/** Palabras genéricas de una dirección, que no la identifican. */
const STREET_WORDS = new Set([
  "calle",
  "avenida",
  "av",
  "avda",
  "pasaje",
  "psje",
  "camino",
  "pje",
  "n",
  "no",
  "numero",
  "depto",
  "departamento",
  "dpto",
  "casa",
  "oficina",
  "of",
  "local",
  "torre",
  "block",
]);

/** El nombre de la calle de una dirección (`Av. Irarrázaval 1234, depto 5` → `irarrazaval`). */
function streetName(address: string): string | null {
  const name = words(address.split(",")[0] ?? "")
    .filter((word) => !/\d/.test(word) && !STREET_WORDS.has(word))
    .join(" ");
  return name.length >= 4 ? name : null;
}

/**
 * Revisa un texto de un canal (spec F2 §4.6): una función pura que corre sobre el texto final,
 * también después de una edición manual, y no se guarda (se calcula al leer). En Instagram, los
 * largos y la cantidad se miden sobre el caption que se publica (`instagramCaption`). El texto
 * revisado es el título y el cuerpo; los hashtags solo cuentan.
 */
export function checkContent(
  platform: Platform,
  text: Pick<AssembledText, "title" | "body" | "hashtags">,
  ctx: ContentCheckContext,
): ContentCheck[] {
  const checks: ContentCheck[] = [];
  const add = (code: ContentCheckCode, message: string) =>
    checks.push({ code, severity: CONTENT_CHECK_SEVERITIES[code], message });

  const content = [text.title ?? "", text.body].join("\n");
  const folded = foldText(content);
  const dataText = briefValues(ctx.brief).join("\n");
  const foldedData = foldText(dataText);

  // Números que no están en los datos ni en el contacto (cada uno una vez).
  const known = new Set(
    numbersIn(`${dataText}\n${ctx.contact.whatsapp ?? ""}`).map((number) => number.key),
  );
  const reported = new Set<string>();
  for (const { raw, key } of numbersIn(content)) {
    if (known.has(key) || reported.has(key)) continue;
    reported.add(key);
    add("NUMBER_NOT_IN_DATA", `El número «${raw}» no está en los datos del aviso`);
  }

  // Dirección y número de unidad, si no se pueden mostrar (y no son ya parte de los datos).
  if (ctx.brief.address === null) {
    const street = ctx.private.address === null ? null : streetName(ctx.private.address);
    if (
      street !== null &&
      new RegExp(String.raw`\b${street}\b`).test(folded) &&
      !foldedData.includes(street)
    ) {
      add("ADDRESS_EXPOSED", "Menciona la calle del aviso, que no se puede mostrar");
    }
    const unit = (ctx.private.unitNumber ?? "").match(/\d+/g) ?? [];
    const shown = new Set(numbersIn(content).map((number) => number.key));
    if (unit.some((digits) => shown.has(numberKey(digits)) && !known.has(numberKey(digits)))) {
      add("ADDRESS_EXPOSED", "Menciona el número de la unidad, que no se puede mostrar");
    }
  }

  // Notas internas: 6 palabras seguidas (o todas, si son entre 3 y 5).
  const notes = words(ctx.private.internalNotes ?? "");
  const size = Math.min(6, notes.length);
  if (size >= 3) {
    const haystack = ` ${words(content).join(" ")} `;
    for (let start = 0; start + size <= notes.length; start += 1) {
      if (haystack.includes(` ${notes.slice(start, start + size).join(" ")} `)) {
        add("INTERNAL_NOTES_LEAK", "Repite un trozo de las notas internas del aviso");
        break;
      }
    }
  }

  for (const { reason, pattern } of DISCRIMINATORY_PATTERNS) {
    if (pattern.test(folded)) {
      add("DISCRIMINATORY", `Tiene un requisito discriminatorio (${reason})`);
    }
  }

  if (platform === "portal_inmobiliario" && hasEmoji(content)) {
    add("EMOJI_NOT_ALLOWED", "Portal Inmobiliario no admite emojis en el título ni la descripción");
  }

  if (platform === "instagram") {
    const length = instagramCaption(text).length;
    if (length > INSTAGRAM_CAPTION_MAX_LENGTH) {
      add(
        "TOO_LONG",
        `El caption tiene ${length} caracteres con los hashtags (máximo ${INSTAGRAM_CAPTION_MAX_LENGTH})`,
      );
    }
  } else if ((text.title ?? "").length > LISTING_TITLE_MAX_LENGTH) {
    add(
      "TOO_LONG",
      `El título tiene ${(text.title ?? "").length} caracteres (máximo ${LISTING_TITLE_MAX_LENGTH})`,
    );
  }

  for (const term of termsIn(folded, AMENITY_TERMS)) {
    if (termsIn(foldedData, [term]).length === 0) {
      add("AMENITY_NOT_IN_DATA", `Menciona «${term}», que no está en los datos del aviso`);
    }
  }

  const superlatives = termsIn(folded, SUPERLATIVE_TERMS);
  if (superlatives.length > 0) {
    add(
      "SUPERLATIVE",
      `Usa superlativos vacíos: ${superlatives.map((term) => `«${term}»`).join(", ")}`,
    );
  }

  if (platform === "instagram") {
    if (/\*\*|__|^#{1,6}\s|\[[^\]]*\]\([^)]*\)/m.test(text.body)) {
      add("MARKDOWN", "Tiene formato markdown (**, encabezados o links), que Instagram no muestra");
    }
    const count = text.hashtags.length;
    if (count < HASHTAGS_MIN || count > HASHTAGS_MAX) {
      add(
        "HASHTAG_COUNT",
        `Tiene ${count} hashtags (lo recomendado es entre ${HASHTAGS_MIN} y ${HASHTAGS_MAX})`,
      );
    }
  }

  return checks;
}

/** `true` si alguna revisión es un error (no solo advertencias). */
export const hasContentErrors = (checks: readonly ContentCheck[]) =>
  checks.some((check) => check.severity === "error");
