// Contenido (spec F2 §4.6, ADR-0013): lo que ve la IA, el prompt, el esquema de su salida, la
// llamada con validación y el ensamblado de los textos por canal.

export {
  type AssembledContents,
  type AssembledText,
  assembleContents,
  type ContentContact,
  EMOJI_PATTERN,
  HASHTAGS_MAX,
  HASHTAGS_MIN,
  hasEmoji,
  INSTAGRAM_CAPTION_MAX_LENGTH,
  instagramCaption,
  LISTING_TITLE_MAX_LENGTH,
  listingTitle,
  normalizeHashtag,
  stripEmoji,
} from "./assemble.js";
export { type BriefFeature, buildContentBrief, type ContentBrief } from "./brief.js";
export {
  CONTENT_DRAFT_JSON_SCHEMA,
  CONTENT_DRAFT_LIMITS,
  type ContentDraft,
  contentDraftSchema,
  SAMPLE_CONTENT_DRAFT,
} from "./draft.js";
export { type GenerateContentDraftResult, generateContentDraft } from "./generate.js";
export { buildContentPrompt, CONTENT_PROMPT_VERSION } from "./prompt.js";
