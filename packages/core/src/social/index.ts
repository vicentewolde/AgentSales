// Textos de posts por red (spec F9 §4.4, ADR-0030): lo que ve la IA, el prompt, el esquema de su
// salida, las reglas de cada red y la revisión.

export {
  buildSocialBrief,
  operatorBriefOf,
  postPlatforms,
  type SocialBrief,
  type SocialTarget,
  socialTargets,
  xLinksOf,
} from "./brief.js";
export { buildPostCheckContext, checkPostContent, type PostCheckContext } from "./check.js";
export {
  normalizePostHashtag,
  normalizePostHashtags,
  SAMPLE_SOCIAL_DRAFT,
  SOCIAL_DRAFT_JSON_SCHEMA,
  SOCIAL_DRAFT_LIMITS,
  type SocialDraft,
  type SocialDraftText,
  socialDraftSchema,
  validateSocialDraft,
} from "./draft.js";
export {
  type DraftedPostText,
  type DraftPostTextsResult,
  draftPostTexts,
} from "./draft-texts.js";
export {
  DISCORD_MAX_FILES,
  escapeLinkedInText,
  INSTAGRAM_HASHTAGS_LIMIT,
  joinedPostText,
  LINKEDIN_RESERVED_CHARACTERS,
  linkKey,
  linksIn,
  neutralizeDiscordMentions,
  POST_TEXT_LIMITS,
  postTextLength,
  X_LINK_POST_COST_USD,
  X_MAX_IMAGES,
  X_POST_COST_USD,
  X_URL_WEIGHT,
  xWeightedLength,
} from "./networks.js";
export { buildSocialPrompt, SOCIAL_PROMPT_VERSION, SOCIAL_SYSTEM_PROMPT } from "./prompt.js";
