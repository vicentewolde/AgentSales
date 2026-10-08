import type { Broker } from "../broker.js";
import type { Platform } from "../enums.js";
import type { FieldDefinition } from "../field-definition.js";
import type { Listing } from "../listing.js";
import { foldText } from "../listing-validator/normalizers.js";
import {
  type AssembledText,
  type ContentContact,
  contentLength,
  HASHTAGS_MAX,
  HASHTAGS_MIN,
  hasEmoji,
} from "./assemble.js";
import { buildContentBrief, type ContentBrief } from "./brief.js";
import {
  AMENITY_EXACT,
  AMENITY_TERMS,
  CONTACT_PATTERNS,
  DISCRIMINATORY_PATTERNS,
  DISTANCE_UNITS,
  NUMBER_WORDS,
  SUPERLATIVE_TERMS,
} from "./check-terms.js";

/** Severidades de la revisión: los errores bloquean, las advertencias no. */
export const CONTENT_CHECK_SEVERITY_LEVELS = ["error", "warning"] as const;

/** Códigos de la revisión editorial (spec F2 §4.6 y F4 §4.7), con su severidad. */
export const CONTENT_CHECK_SEVERITIES = {
  NUMBER_NOT_IN_DATA: "error",
  ADDRESS_EXPOSED: "error",
  CONTACT_IN_TEXT: "error",
  INTERNAL_NOTES_LEAK: "error",
  DISCRIMINATORY: "error",
  EMOJI_NOT_ALLOWED: "error",
  TOO_LONG: "error",
  AMENITY_NOT_IN_DATA: "warning",
  SUPERLATIVE: "warning",
  MARKDOWN: "warning",
  HASHTAG_COUNT: "warning",
} as const satisfies Record<string, (typeof CONTENT_CHECK_SEVERITY_LEVELS)[number]>;
export type ContentCheckCode = keyof typeof CONTENT_CHECK_SEVERITIES;
export type ContentCheckSeverity = (typeof CONTENT_CHECK_SEVERITY_LEVELS)[number];

/** Los códigos como tupla, para `z.enum` en los contratos de la API (F2-T12). */
export const CONTENT_CHECK_CODES = Object.keys(CONTENT_CHECK_SEVERITIES) as [
  ContentCheckCode,
  ...ContentCheckCode[],
];

/** Un problema del texto: los errores bloquean (`eval:content` sale con 1), las advertencias no. */
export type ContentCheck = {
  code: ContentCheckCode;
  severity: ContentCheckSeverity;
  message: string;
};

/**
 * Lo que la revisión necesita: el brief (los datos permitidos), el contacto que pone el código y lo
 * **privado** del aviso, que nunca va a la IA pero sirve para detectar una fuga (por ejemplo, en
 * una edición manual). Lo privado no sale del servidor: la API devuelve solo los `checks`, y sus
 * mensajes nunca citan la dirección, la unidad ni las notas.
 */
export type ContentCheckContext = {
  brief: ContentBrief;
  contact: ContentContact;
  private: { address: string | null; unitNumber: string | null; internalNotes: string | null };
};

/**
 * El contexto de la revisión de un aviso, con el mismo brief que ve la IA. Quien genera y revisa
 * (T10 y T16) lo arma una vez y usa `ctx.brief` y `ctx.contact` también para la IA y el ensamblado,
 * así la revisión mide contra los mismos datos.
 */
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

/**
 * Términos de una lista (con tildes) que aparecen como palabra, o con su plural simple, en un texto
 * plegado. Los términos no llevan metacaracteres. Si uno más largo los contiene (`jardín infantil`
 * y `jardín`), queda solo el largo.
 */
function termsIn(folded: string, terms: readonly string[], exact: ReadonlySet<string> = new Set()) {
  const found = terms.filter((term) => {
    const key = foldText(term);
    const plural = exact.has(key) ? "" : "(?:s|es)?";
    return new RegExp(String.raw`\b${key}${plural}\b`).test(folded);
  });
  return found.filter(
    (term) => !found.some((other) => other !== term && foldText(other).includes(foldText(term))),
  );
}

const words = (text: string) => foldText(text).match(/[a-z0-9]+/g) ?? [];

/**
 * Palabras de una dirección que no la identifican: tipos de vía, de unidad, artículos y adjetivos
 * frecuentes en nombres de calles ("Avenida Central" no hace sospechosa a "ubicación central").
 */
const STREET_WORDS = new Set([
  "los",
  "las",
  "del",
  "de",
  "la",
  "el",
  "y",
  "central",
  "principal",
  "norte",
  "sur",
  "oriente",
  "poniente",
  "nueva",
  "nuevo",
  "grande",
  "alto",
  "alta",
  "real",
  "general",
  "santa",
  "santo",
  "san",
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

/**
 * Las palabras que identifican la calle de una dirección, de todos sus tramos (`Depto 506, Av.
 * Vicuña Mackenna 1234` → `vicuna` y `mackenna`): de 5 letras o más, sin números ni genéricas.
 * Solo letras y números, así que se pueden comparar palabra a palabra.
 */
function streetWords(address: string): string[] {
  return words(address).filter(
    (word) => word.length >= 5 && !/\d/.test(word) && !STREET_WORDS.has(word),
  );
}

/** Notas de una o dos palabras se buscan solo si son una frase con algo de cuerpo. */
const SHORT_NOTES_MIN_CHARS = 8;

/**
 * Las direcciones web de las notas: no son prosa (un slug como `a-pasos-de-la-plaza` no es fuga).
 * Terminan antes de una coma, un punto y coma, un paréntesis o un punto final, así el texto pegado
 * a ellas ("…/aviso, dueño urgente") se sigue revisando.
 */
const URL = /\b(?:https?:\/\/|www\.)[^\s,;)]*[^\s,;).]/gi;

/**
 * Fin de una frase: `.`, `!`, `?`, `;`, `:` o un salto de línea. Un punto solo no corta entre dos
 * dígitos (`5.800`); después de un número sí (`UF 5.800. A pasos…`).
 */
const SENTENCE_END = /\.(?!\d)|(?<!\d)\.|[!?;:]|\n/;

/**
 * Las palabras de un texto con los fines de frase como `|`. Las notas y el texto se parten igual:
 * una copia de las notas con su misma puntuación coincide, y dos frases del texto que solo juntas
 * forman un trozo de las notas ("sector Pedro de Valdivia. A pasos de…") no.
 */
const sentenceTokens = (text: string): string[] =>
  text
    .split(SENTENCE_END)
    .map(words)
    .filter((sentence) => sentence.length > 0)
    .flatMap((sentence, index) => (index === 0 ? sentence : ["|", ...sentence]));

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
  // Y con palabras junto a una distancia o un tiempo: `a cinco minutos`, `dos cuadras`.
  const spelled = new RegExp(
    String.raw`\b(${Object.keys(NUMBER_WORDS).join("|")})\s+${DISTANCE_UNITS}\b`,
    "g",
  );
  for (const match of folded.matchAll(spelled)) {
    const key = String(NUMBER_WORDS[match[1] ?? ""]);
    if (known.has(key) || reported.has(match[0])) continue;
    reported.add(match[0]);
    add("NUMBER_NOT_IN_DATA", `«${match[0]}» no está en los datos del aviso`);
  }

  // Dirección y número de unidad, si no se pueden mostrar (y no son parte de otros datos). En
  // Portal nunca van en el texto, aunque `show_exact_address = true`: la dirección va en la
  // ubicación del ítem (spec F4 §4.7). La calle se busca también en los hashtags, que se publican
  // con el caption.
  const contentWords = words(content);
  if (ctx.brief.address === null || platform === "portal_inmobiliario") {
    // Los datos sin la dirección ni la unidad: lo que el texto sí puede repetir.
    const otherData = briefValues({ ...ctx.brief, address: null, unitNumber: null }).join("\n");
    const dataWords = new Set(words(otherData));
    const otherNumbers = new Set(
      numbersIn(`${otherData}\n${ctx.contact.whatsapp ?? ""}`).map((number) => number.key),
    );
    const street = streetWords(ctx.private.address ?? "").filter((word) => !dataWords.has(word));
    const tags = text.hashtags.map((tag) => foldText(tag).replace(/[^a-z0-9]/g, ""));
    const inWords = new Set([...contentWords, ...tags.flatMap((tag) => words(tag))]);
    const joined = street.join("");
    if (
      street.some((word) => inWords.has(word)) ||
      (joined.length > 0 && tags.some((tag) => tag.includes(joined)))
    ) {
      add("ADDRESS_EXPOSED", "Menciona la calle del aviso, que no se puede mostrar");
    }
    const unit = (ctx.private.unitNumber ?? "").match(/\d+/g) ?? [];
    const shown = new Set(numbersIn(content).map((number) => number.key));
    const exposed = (digits: string) =>
      shown.has(numberKey(digits)) && !otherNumbers.has(numberKey(digits));
    if (unit.some(exposed)) {
      add("ADDRESS_EXPOSED", "Menciona el número de la unidad, que no se puede mostrar");
    }
    // El número de la calle: sin la dirección en los datos ya lo marca NUMBER_NOT_IN_DATA; en
    // Portal con `show_exact_address = true` sí está en los datos y aun así no va en el texto.
    const streetNumbers = (ctx.private.address ?? "").match(/\d+/g) ?? [];
    if (ctx.brief.address !== null && streetNumbers.some(exposed)) {
      add(
        "ADDRESS_EXPOSED",
        "Menciona el número de la dirección, que en Portal va en la ubicación",
      );
    }
  }

  // Portal modera el título o la descripción con datos de contacto: van solo en el aviso.
  if (platform === "portal_inmobiliario") {
    for (const { kind, pattern } of CONTACT_PATTERNS) {
      if (pattern.test(content)) {
        add(
          "CONTACT_IN_TEXT",
          `Tiene ${kind}: Portal Inmobiliario modera los datos de contacto en el texto (el contacto va en el aviso)`,
        );
      }
    }
  }

  // Notas internas: 6 palabras seguidas (o todas, si son menos), con los fines de frase de las
  // notas y del texto en el mismo lugar, salvo que ese trozo también esté en los datos (por
  // ejemplo, "departamento en venta"). Las direcciones web de las notas no cuentan.
  const noteTokens = sentenceTokens((ctx.private.internalNotes ?? "").replace(URL, " "));
  const notes = noteTokens.filter((token) => token !== "|");
  const size = Math.min(6, notes.length);
  const longEnough = size >= 3 || notes.join(" ").length >= SHORT_NOTES_MIN_CHARS;
  if (size > 0 && longEnough) {
    const haystack = ` ${sentenceTokens(content).join(" ")} `;
    // Lo permitido incluye la operación como la escribe el código (`Departamento en venta`).
    const operation = ctx.brief.operation === "rent" ? "en arriendo" : "en venta";
    const allowed = ` ${words(
      `${dataText}\n${ctx.brief.propertyType ?? ""} ${ctx.brief.operation === null ? "" : operation}\n${ctx.contact.whatsapp ?? ""}`,
    ).join(" ")} `;
    // Cada trozo: `size` palabras seguidas de las notas, con sus fines de frase entremedio.
    const starts = noteTokens.flatMap((token, index) => (token === "|" ? [] : [index]));
    for (const [n, start] of starts.entries()) {
      const end = starts[n + size - 1];
      if (end === undefined) break;
      const piece = ` ${noteTokens.slice(start, end + 1).join(" ")} `;
      if (haystack.includes(piece) && !allowed.includes(piece.replaceAll(" |", ""))) {
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

  const { length, max } = contentLength(platform, text);
  if (length > max) {
    add(
      "TOO_LONG",
      platform === "instagram"
        ? `El caption tiene ${length} caracteres con los hashtags (máximo ${max})`
        : `El título tiene ${length} caracteres (máximo ${max})`,
    );
  }

  for (const term of termsIn(folded, AMENITY_TERMS, AMENITY_EXACT)) {
    if (termsIn(foldedData, [term], AMENITY_EXACT).length === 0) {
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
