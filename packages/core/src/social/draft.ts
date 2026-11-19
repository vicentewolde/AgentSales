import { z } from "zod";
import { describeIssues, type Validated } from "../content/generate.js";
import { LANGUAGES, POST_PLATFORMS } from "../enums.js";
import type { SocialBrief, SocialTarget } from "./brief.js";

/**
 * Topes del borrador de un post (en caracteres; los hashtags y advertencias, en elementos). Son
 * holgados a propósito: el largo de cada red lo revisa `checkPostContent` (`TOO_LONG`), que
 * también corre tras una edición; el esquema solo frena una respuesta absurda.
 */
export const SOCIAL_DRAFT_LIMITS = {
  body: 5000,
  hashtag: 100,
  hashtags: 30,
  texts: 20,
  warning: 300,
  warnings: 10,
  /** Los textos de las láminas (B5): titular y subtítulo, holgados (las palabras las revisa el check). */
  slides: 24,
  slideHeadline: 200,
  slideSubtitle: 400,
} as const;

/** El papel de la lámina que escribe la IA: la portada o un punto (el cierre es la marca). */
export const SOCIAL_SLIDE_ROLES = ["cover", "point"] as const;

/** La forma del borrador; con `limits`, con topes y recortes (la de validar). */
function draftShape(limits: boolean) {
  const list = <T extends z.ZodType>(item: T, max: number) =>
    limits ? z.array(item).max(max) : z.array(item);
  return z.strictObject({
    texts: list(
      z.strictObject({
        platform: z.enum(POST_PLATFORMS),
        language: z.enum(LANGUAGES),
        body: limits ? z.string().trim().min(1).max(SOCIAL_DRAFT_LIMITS.body) : z.string(),
        hashtags: list(
          limits ? z.string().trim().min(1).max(SOCIAL_DRAFT_LIMITS.hashtag) : z.string(),
          SOCIAL_DRAFT_LIMITS.hashtags,
        ),
      }),
      SOCIAL_DRAFT_LIMITS.texts,
    ),
    warnings: list(
      limits ? z.string().trim().max(SOCIAL_DRAFT_LIMITS.warning) : z.string(),
      SOCIAL_DRAFT_LIMITS.warnings,
    ),
    // F9.7 B5: los textos de las láminas, solo en un post de imagen o carrusel (si no, vacía). Es
    // opcional: una respuesta sin ella sigue sirviendo (los textos no se pierden por las láminas).
    slides: list(
      z.strictObject({
        language: z.enum(LANGUAGES),
        role: z.enum(SOCIAL_SLIDE_ROLES),
        headline: limits
          ? z.string().trim().min(1).max(SOCIAL_DRAFT_LIMITS.slideHeadline)
          : z.string(),
        subtitle: limits ? z.string().trim().max(SOCIAL_DRAFT_LIMITS.slideSubtitle) : z.string(),
      }),
      SOCIAL_DRAFT_LIMITS.slides,
    ).optional(),
  });
}

/**
 * Lo que devuelve la IA para un post (ADR-0030): el texto completo de cada red e idioma, con sus
 * hashtags aparte. Esquema estricto; lo validado se guarda en `contents.raw_output`.
 */
export const socialDraftSchema = draftShape(true);
export type SocialDraft = z.infer<typeof socialDraftSchema>;
export type SocialDraftText = SocialDraft["texts"][number];
export type SocialDraftSlide = NonNullable<SocialDraft["slides"]>[number];

/** JSON Schema (draft-07) que va al proveedor: la misma forma sin topes (ADR-0013). */
export const SOCIAL_DRAFT_JSON_SCHEMA: Record<string, unknown> = z.toJSONSchema(draftShape(false), {
  target: "draft-07",
});

/**
 * Un hashtag de un post: `#` y después letras (con tildes y mayúsculas, que las redes respetan),
 * números y `_`; `null` si no queda nada.
 */
export function normalizePostHashtag(tag: string): string | null {
  const word = tag.replace(/[^\p{L}\p{N}_]/gu, "");
  return word === "" ? null : `#${word}`;
}

/** Hashtags normalizados y sin repetir (sin mirar mayúsculas), en su orden. */
export function normalizePostHashtags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const normalized = normalizePostHashtag(tag);
    if (normalized === null || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    result.push(normalized);
  }
  return result;
}

/**
 * Valida la respuesta de la IA para los textos pedidos: el esquema y, además, **un texto por cada
 * red e idioma pedidos**. Uno que falta es un motivo de reintento; los que no se pidieron o se
 * repiten se descartan (queda el primero). Devuelve los textos en el orden de `targets`, con los
 * hashtags normalizados. Los motivos son textos fijos (la red y el idioma son de `targets`).
 */
export function validateSocialDraft(
  data: unknown,
  targets: readonly SocialTarget[],
  slides: SocialBrief["slides"] = null,
): Validated<SocialDraft> {
  const parsed = socialDraftSchema.safeParse(data);
  if (!parsed.success) return { success: false, issues: describeIssues(parsed.error) };
  const texts: SocialDraftText[] = [];
  const issues: string[] = [];
  for (const { platform, language } of targets) {
    const found = parsed.data.texts.find(
      (text) => text.platform === platform && text.language === language,
    );
    if (found === undefined) issues.push(`texts: falta el texto de ${platform} en ${language}`);
    else texts.push({ ...found, hashtags: normalizePostHashtags(found.hashtags) });
  }
  if (issues.length > 0) return { success: false, issues };
  return {
    success: true,
    data: { texts, warnings: parsed.data.warnings, slides: pickSlides(parsed.data.slides, slides) },
  };
}

/**
 * Las láminas que sirven de lo que devolvió la IA (B5): solo las de los idiomas pedidos, una
 * portada por idioma (la primera) y hasta `maxPoints` puntos, en su orden. Nunca motivo de
 * reintento: sin láminas, el post se dibuja como antes.
 */
export function pickSlides(
  raw: readonly SocialDraftSlide[] | undefined,
  wanted: SocialBrief["slides"],
): SocialDraftSlide[] {
  if (wanted === null || raw === undefined) return [];
  const picked: SocialDraftSlide[] = [];
  for (const language of wanted.languages) {
    const mine = raw.filter((slide) => slide.language === language);
    const cover = mine.find((slide) => slide.role === "cover");
    if (cover === undefined) continue;
    picked.push(cover);
    picked.push(...mine.filter((slide) => slide.role === "point").slice(0, wanted.maxPoints));
  }
  return picked;
}

/**
 * Borrador de ejemplo con todas las redes en los dos idiomas: frases sin cifras, nombres propios,
 * enlaces, menciones ni primera persona del plural (pasa `checkPostContent` con cualquier perfil y
 * respeta la voz de una marca que no es un equipo, F9.5-T23). Lo devuelve el proveedor
 * `fake` del worker en `post.draft` (`LLM_PROVIDER=fake`); `validateSocialDraft` se queda con lo
 * pedido.
 */
export const SAMPLE_SOCIAL_DRAFT: SocialDraft = {
  texts: POST_PLATFORMS.flatMap((platform) => [
    {
      platform,
      language: "es" as const,
      body: "Una reflexión sobre cómo se trabaja y lo que se aprende en el camino.\nCuéntame qué te parece.",
      hashtags: platform === "discord" ? [] : ["#contenido"],
    },
    {
      platform,
      language: "en" as const,
      body: "A thought about how the work gets done and what it teaches along the way.\nTell me what you think.",
      hashtags: platform === "discord" ? [] : ["#content"],
    },
  ]),
  warnings: [],
  slides: (["es", "en"] as const).flatMap((language) => [
    {
      language,
      role: "cover" as const,
      headline: language === "es" ? "Lo que se aprende en el camino" : "What the work teaches",
      subtitle:
        language === "es"
          ? "Una reflexión sobre cómo se trabaja."
          : "A thought about how the work gets done.",
    },
    {
      language,
      role: "point" as const,
      headline: language === "es" ? "Empezar por lo simple" : "Start with the simple part",
      subtitle:
        language === "es" ? "Lo simple se puede revisar." : "The simple part can be checked.",
    },
  ]),
};
