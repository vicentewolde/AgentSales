// Contenido (spec F2 §4.6, ADR-0013): lo que ve la IA, el prompt, el esquema de su salida, la
// llamada con validación y el ensamblado de los textos por canal.

export {
  type AssembledContents,
  type AssembledText,
  assembleContents,
  type ContentContact,
  contentLength,
  EMOJI_PATTERN,
  HASHTAGS_MAX,
  HASHTAGS_MIN,
  hasEmoji,
  INSTAGRAM_CAPTION_MAX_LENGTH,
  instagramCaption,
  LISTING_TITLE_MAX_LENGTH,
  listingTitle,
  normalizeHashtag,
  normalizeHashtags,
  stripEmoji,
} from "./assemble.js";
export { type BriefFeature, buildContentBrief, type ContentBrief } from "./brief.js";
export {
  buildContentCheckContext,
  CONTENT_CHECK_CODES,
  CONTENT_CHECK_SEVERITIES,
  CONTENT_CHECK_SEVERITY_LEVELS,
  type ContentCheck,
  type ContentCheckCode,
  type ContentCheckContext,
  type ContentCheckSeverity,
  checkContent,
  hasContentErrors,
} from "./check.js";
export {
  type CheckedContent,
  type ContentCheckDeps,
  loadCheckContext,
} from "./check-context.js";
export {
  CAROUSEL_MAX_ITEMS,
  composeCarousel,
  composePhotoSet,
  composeReel,
  coverPhoto,
  variantOf,
  videosOf,
} from "./compose.js";
export {
  CONTENT_DRAFT_JSON_SCHEMA,
  CONTENT_DRAFT_LIMITS,
  type ContentDraft,
  contentDraftSchema,
  SAMPLE_CONTENT_DRAFT,
} from "./draft.js";
export {
  type DraftedText,
  type DraftListingTextsResult,
  draftListingTexts,
} from "./draft-texts.js";
export { type GenerateContentDraftResult, generateContentDraft } from "./generate.js";
export { reelPath, reelTextInput, renderInput, renderPath, variantPath } from "./media-keys.js";
export { buildContentPrompt, CONTENT_PROMPT_VERSION } from "./prompt.js";
export {
  coverData,
  coverFacts,
  reelOverlayData,
  slideBrand,
  specSheetData,
} from "./slides-data.js";
