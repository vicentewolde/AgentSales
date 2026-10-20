import type { AbortSignalLike } from "../abort.js";
import type { ContentCheck } from "../content/check.js";
import { type GenerateDeps, generateValidated } from "../content/generate.js";
import type { Language, PostPlatform } from "../enums.js";
import type { SocialBrief } from "./brief.js";
import { checkPostContent, type PostCheckContext } from "./check.js";
import { SOCIAL_DRAFT_JSON_SCHEMA, type SocialDraft, validateSocialDraft } from "./draft.js";
import { buildSocialPrompt } from "./prompt.js";

/** Un texto de un post redactado: la red, el idioma, el texto y su revisión. */
export type DraftedPostText = {
  platform: PostPlatform;
  language: Language;
  body: string;
  hashtags: string[];
  checks: ContentCheck[];
};

export type DraftPostTextsResult = {
  draft: SocialDraft;
  texts: DraftedPostText[];
  model: string;
  attempts: number;
  promptChars: number;
};

/**
 * El camino de los textos de un post (spec F9 §4.4, ADR-0030): el brief a la IA, la validación con
 * un texto por red e idioma pedidos (con un reintento) y la revisión de cada uno
 * (`checkPostContent`). Lo usa la corrida `post.draft` y lo podrá usar la evaluación (T22).
 */
export async function draftPostTexts(
  deps: GenerateDeps,
  params: { brief: SocialBrief; ctx: PostCheckContext; signal?: AbortSignalLike },
): Promise<DraftPostTextsResult> {
  const { data, ...rest } = await generateValidated(deps, {
    buildPrompt: (issues) => buildSocialPrompt(params.brief, issues),
    jsonSchema: SOCIAL_DRAFT_JSON_SCHEMA,
    validate: (raw) => validateSocialDraft(raw, params.brief.targets),
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  });
  return {
    ...rest,
    draft: data,
    texts: data.texts.map((text) => ({
      platform: text.platform,
      language: text.language,
      body: text.body,
      hashtags: text.hashtags,
      checks: checkPostContent(text.platform, text, params.ctx),
    })),
  };
}
