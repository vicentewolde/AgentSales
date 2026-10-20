// TikTok en modo *Upload*, el video como borrador en la bandeja (spec F9 §4.6, D16, F9-T26): lo que
// componen el worker y la API.
export { createTikTokAuth, type TikTokAuthOptions } from "./auth.js";
export {
  TIKTOK_API_ORIGIN,
  TIKTOK_AUTHORIZE_URL,
  TIKTOK_CHUNK_BYTES,
  TIKTOK_LIMITS,
  TIKTOK_REFRESH_TIMEOUT_MS,
  TIKTOK_REQUEST_TIMEOUT_MS,
  TIKTOK_STATUS_POLL,
} from "./constants.js";
export {
  type ChunkPlan,
  type ChunkRange,
  chunkPlan,
  chunkRanges,
  createTikTokContent,
  type InboxVideoInit,
  type PublishStatus,
  type TikTokContentClient,
  type TikTokContentOptions,
} from "./content.js";
export {
  isTikTokRefreshRejected,
  isTikTokTokenRejected,
  tiktokApiError,
  tiktokOAuthError,
} from "./errors.js";
export {
  createTikTokPublisher,
  readChunkFromStorage,
  TIKTOK_INBOX_NOTE,
  type TikTokPublisherOptions,
  type TikTokPublishNote,
  tiktokVideoOf,
  validateTikTokInput,
} from "./publisher.js";
