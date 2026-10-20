// LinkedIn, perfil personal (spec F9 §4.6 y §4.7, F9-T15): lo que componen el worker y la API.
export {
  createLinkedInApi,
  isLinkedInUploadUrl,
  type LinkedInApi,
  type LinkedInApiOptions,
  type LinkedInPostContent,
  type LinkedInPostRequest,
  linkedinPostBody,
} from "./api.js";
export { createLinkedInAuth, type LinkedInAuthOptions } from "./auth.js";
export {
  LINKEDIN_API_ORIGIN,
  LINKEDIN_API_VERSION,
  LINKEDIN_API_VERSION_SUNSET,
  LINKEDIN_LIMITS,
  LINKEDIN_OAUTH_ORIGIN,
  LINKEDIN_SCOPES,
} from "./constants.js";
export { isLinkedInNotSent, LINKEDIN_NOT_SENT_CODES, linkedinHttpError } from "./errors.js";
export {
  createLinkedInOperations,
  createLinkedInPublisher,
  deleteLinkedInPost,
  type LinkedInPublisherOptions,
  type LinkedInPublishNote,
  type MediaRange,
  readMediaFromUrl,
  validateLinkedInInput,
} from "./publisher.js";
