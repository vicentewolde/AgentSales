import { z } from "zod";
import { CONTENT_CHECK_SEVERITIES, type ContentCheck } from "./content/check.js";
import { LANGUAGES, type Language } from "./enums.js";
import { AppError } from "./errors.js";
import { foldText } from "./listing-validator/normalizers.js";
import type { CardSpec } from "./ports/card-renderer.js";
import { unsupportedFacts } from "./social/check.js";

// Los textos de las láminas de un post (spec F9.7 B5, ADR-0043 punto 6): al redactar un post de
// imagen o carrusel, la IA escribe la portada (titular y subtítulo) y, en un carrusel, una lámina
// por punto, por idioma (`post_card_texts`). Pasan por la misma revisión de hechos y de «evitar»
// que los textos, y el operador los edita (`approved`: redactar de nuevo no los pisa).

export const CARD_TEXT_ROLES = ["cover", "point"] as const;
export type CardTextRole = (typeof CARD_TEXT_ROLES)[number];

/** Los topes de B5: titular de hasta 8 palabras y subtítulo de hasta 20; y en caracteres. */
export const CARD_TEXT_LIMITS = {
  headlineWords: 8,
  subtitleWords: 20,
  headlineChars: 120,
  subtitleChars: 240,
  /** Láminas por idioma: la portada y hasta 8 puntos (las tarjetas de siempre). */
  perLanguage: 9,
  /**
   * Los puntos clave de un post de imagen: van en la misma imagen, en la grilla de «Explicar»
   * (3 caben en todas las proporciones, también en 1:1).
   */
  imagePoints: 3,
} as const;

export const postCardTextSchema = z.object({
  postId: z.string(),
  language: z.enum(LANGUAGES),
  /** Desde 1: la portada es la 1. */
  position: z.number().int().positive(),
  role: z.enum(CARD_TEXT_ROLES),
  headline: z.string(),
  subtitle: z.string(),
  /** El operador los revisó o editó. */
  approved: z.boolean(),
  updatedAt: z.date(),
});
export type PostCardText = z.infer<typeof postCardTextSchema>;

/** Una lámina nueva de un idioma (sin el post ni el idioma, que van aparte). */
export type NewCardText = Pick<PostCardText, "role" | "headline" | "subtitle">;

const words = (text: string) => text.trim().split(/\s+/u).filter(Boolean).length;

/**
 * La revisión de una lámina (B5): una cifra, un nombre, un enlace o una mención que no están en las
 * fuentes de hechos (`FACT_NOT_IN_PROFILE`, error, como en los textos), algo de «evitar»
 * (`AVOID_TERM`) y el largo (`TOO_LONG`: más de 8 palabras en el titular o 20 en el subtítulo).
 */
export function checkCardText(
  text: Pick<PostCardText, "headline" | "subtitle">,
  ctx: { sources: string; avoid: readonly string[] },
): ContentCheck[] {
  const checks: ContentCheck[] = [];
  const add = (code: ContentCheck["code"], message: string) =>
    checks.push({ code, severity: CONTENT_CHECK_SEVERITIES[code], message });
  for (const message of unsupportedFacts(`${text.headline}\n${text.subtitle}`, ctx.sources)) {
    add("FACT_NOT_IN_PROFILE", message);
  }
  if (words(text.headline) > CARD_TEXT_LIMITS.headlineWords) {
    add(
      "TOO_LONG",
      `El titular tiene ${words(text.headline)} palabras: son ${CARD_TEXT_LIMITS.headlineWords} como máximo`,
    );
  }
  if (words(text.subtitle) > CARD_TEXT_LIMITS.subtitleWords) {
    add(
      "TOO_LONG",
      `El subtítulo tiene ${words(text.subtitle)} palabras: son ${CARD_TEXT_LIMITS.subtitleWords} como máximo`,
    );
  }
  const folded = foldText(`${text.headline}\n${text.subtitle}`);
  for (const term of ctx.avoid) {
    const key = foldText(term);
    if (key !== "" && folded.includes(key)) {
      add("AVOID_TERM", `Usa «${term}», que el perfil pide evitar`);
    }
  }
  return checks;
}

/** Lo que llega al editar las láminas de un idioma: la lista completa, en orden. */
export type CardTextsInput = { headline: string; subtitle?: string | null }[];

/**
 * Las láminas editadas de un idioma: recortadas, la primera es la portada y las demás puntos; sin
 * saltos de línea ni láminas vacías; hasta 9, titular hasta 120 caracteres y subtítulo hasta 240.
 * `CARD_TEXTS_INVALID` (400) si algo no sirve (el largo en palabras es un aviso de la revisión).
 */
export function normalizeCardTexts(input: CardTextsInput): NewCardText[] {
  const L = CARD_TEXT_LIMITS;
  const problems: string[] = [];
  const out: NewCardText[] = [];
  input.forEach((raw, index) => {
    const headline = raw.headline.replace(/\s+/gu, " ").trim();
    const subtitle = (raw.subtitle ?? "").replace(/\s+/gu, " ").trim();
    if (headline === "") {
      problems.push(`la lámina ${index + 1} no tiene titular`);
      return;
    }
    if (headline.length > L.headlineChars) {
      problems.push(`el titular de la lámina ${index + 1} pasa de ${L.headlineChars} caracteres`);
    }
    if (subtitle.length > L.subtitleChars) {
      problems.push(`el subtítulo de la lámina ${index + 1} pasa de ${L.subtitleChars} caracteres`);
    }
    out.push({ role: out.length === 0 ? "cover" : "point", headline, subtitle });
  });
  if (out.length === 0) problems.push("falta al menos la portada");
  if (out.length > L.perLanguage) problems.push(`son ${L.perLanguage} láminas como máximo`);
  if (problems.length > 0) {
    throw new AppError("CARD_TEXTS_INVALID", `Revisa las láminas: ${problems.join("; ")}`);
  }
  return out;
}

/**
 * El mazo de las láminas con estilo desde sus textos (B6): la portada (titular, subtítulo y, en
 * «Explicar», los puntos en grilla), un punto por lámina (un carrusel) y el cierre con la marca.
 * Una imagen sola es solo la portada, con sus puntos clave (hasta `CARD_TEXT_LIMITS.imagePoints`)
 * en la grilla. `maxPoints` es el tope de la red más estricta.
 */
export function cardDeckFromTexts(params: {
  texts: readonly Pick<PostCardText, "role" | "headline" | "subtitle" | "position">[];
  kind: "image" | "carousel" | "video";
  brandName: string;
  detail: string | null;
  maxPoints: number;
}): CardSpec[] {
  const sorted = [...params.texts].sort((a, b) => a.position - b.position);
  const cover = sorted.find((text) => text.role === "cover");
  const cap =
    params.kind === "image"
      ? Math.min(params.maxPoints, CARD_TEXT_LIMITS.imagePoints)
      : params.maxPoints;
  const points = sorted.filter((text) => text.role === "point").slice(0, Math.max(0, cap));
  const items = points.map((point, index) => ({
    label: String(index + 1).padStart(2, "0"),
    text: point.headline,
  }));
  if (cover === undefined) return [];
  if (params.kind === "image") {
    return [
      {
        role: "cover",
        text: cover.headline,
        subtitle: cover.subtitle === "" ? null : cover.subtitle,
        detail: params.detail,
        position: 1,
        total: 1,
        items,
      },
    ];
  }
  const total = points.length + 2;
  return [
    {
      role: "cover",
      text: cover.headline,
      subtitle: cover.subtitle === "" ? null : cover.subtitle,
      detail: params.detail,
      position: 1,
      total,
      items,
    },
    ...points.map((point, index) => ({
      role: "point" as const,
      text: point.headline,
      subtitle: point.subtitle === "" ? null : point.subtitle,
      detail: params.detail,
      position: index + 2,
      total,
    })),
    { role: "closing", text: params.brandName, detail: params.detail, position: total, total },
  ];
}

/** Las láminas de un idioma, en orden. */
export const cardTextsOf = (texts: readonly PostCardText[], language: Language) =>
  texts.filter((text) => text.language === language).sort((a, b) => a.position - b.position);
