// Discord por webhook de canal (spec F9 §4.6, F9-T14): lo que componen el worker y la API.
export {
  DISCORD_API_ORIGIN,
  DISCORD_API_VERSION,
  DISCORD_LIMITS,
  DISCORD_RATE_LIMIT_INLINE,
} from "./constants.js";
export { DISCORD_NOT_SENT_CODES, discordHttpError, isDiscordNotSent } from "./errors.js";
export {
  createDiscordPublisher,
  DISCORD_VIDEO_NOT_ATTACHED_NOTE,
  type DiscordPublisherOptions,
  type DiscordPublishNote,
  discordAttachments,
  neutralizeMassMentions,
  validateDiscordInput,
} from "./publisher.js";
export {
  createDiscordWebhooks,
  DISCORD_ALLOWED_MENTIONS,
  type DiscordFile,
  type DiscordMessage,
  type DiscordMessageRequest,
  type DiscordWebhookClient,
  type DiscordWebhookOptions,
} from "./webhook.js";
