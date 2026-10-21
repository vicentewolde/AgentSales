import { z } from "zod";
import { describeIssues, type Validated } from "../content/generate.js";
import { LANGUAGES, POST_PLATFORMS } from "../enums.js";
import type { SocialTarget } from "./brief.js";

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
} as const;

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
  });
}

/**
 * Lo que devuelve la IA para un post (ADR-0030): el texto completo de cada red e idioma, con sus
 * hashtags aparte. Esquema estricto; lo validado se guarda en `contents.raw_output`.
 */
export const socialDraftSchema = draftShape(true);
export type SocialDraft = z.infer<typeof socialDraftSchema>;
export type SocialDraftText = SocialDraft["texts"][number];

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
  return { success: true, data: { texts, warnings: parsed.data.warnings } };
}

/**
 * Borrador de ejemplo con todas las redes en los dos idiomas: frases sin cifras, nombres propios,
 * enlaces ni menciones (pasa `checkPostContent` con cualquier perfil). Lo devuelve el proveedor
 * `fake` del worker en `post.draft` (`LLM_PROVIDER=fake`); `validateSocialDraft` se queda con lo
 * pedido.
 */
export const SAMPLE_SOCIAL_DRAFT: SocialDraft = {
  texts: POST_PLATFORMS.flatMap((platform) => [
    {
      platform,
      language: "es" as const,
      body: "Hoy compartimos una reflexión sobre cómo trabajamos y qué aprendimos en el camino.\nCuéntanos qué te parece.",
      hashtags: platform === "discord" ? [] : ["#contenido"],
    },
    {
      platform,
      language: "en" as const,
      body: "Today we share a thought about how we work and what we learned along the way.\nTell us what you think.",
      hashtags: platform === "discord" ? [] : ["#content"],
    },
  ]),
  warnings: [],
};
