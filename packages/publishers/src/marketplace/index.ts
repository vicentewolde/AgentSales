/**
 * Facebook Marketplace con Playwright (spec F5, ADR-0017). Subruta propia
 * (`@agentsales/publishers/marketplace`): solo la importa el worker, así la API no carga Playwright.
 */

export {
  describeRequest,
  sanitizeDiagnosticText,
  watchPageProblems,
} from "./diagnostics.js";
export { MARKETPLACE_ERRORS } from "./errors.js";
export {
  captureFormEvidence,
  captureOpenLists,
  describeFormShape,
  type MarketplaceEvidence,
  type MarketplaceListsEvidence,
  type MarketplaceShapeStep,
  stopRecord,
} from "./evidence.js";
export { type FillMarketplaceOptions, fillMarketplaceForm } from "./fill.js";
export {
  classifyPage,
  type MarketplacePageKind,
  pathOf,
  type RequireFormOptions,
  requireForm,
  stopErrorOf,
} from "./guard.js";
export {
  isMarketplaceProfileInUse,
  MARKETPLACE_PROFILE_BUSY_WAIT_MS,
  type MarketplaceProfile,
  marketplaceProfileDir,
  marketplaceProfileLockPath,
  type OpenMarketplaceProfileOptions,
  openMarketplaceProfile,
  openProfileWhenFree,
} from "./profile.js";
export {
  createMarketplacePublisher,
  MARKETPLACE_MAX_PHOTOS,
  MARKETPLACE_MAX_TITLE,
  MARKETPLACE_PUBLISH_MAX_MS,
  type MarketplaceHandoffRef,
  type MarketplacePublisherDeps,
  marketplaceAttemptDir,
  validateMarketplaceInput,
} from "./publisher.js";
export {
  FACEBOOK_HOME_URL,
  FACEBOOK_ORIGIN,
  MARKETPLACE_FORM_URL,
  SESSION_COOKIE,
} from "./selectors.js";
export {
  hasSession,
  type WaitForSessionOptions,
  waitForSession,
} from "./session.js";
export {
  createMarketplaceWindow,
  type MarketplaceWindow,
  type MarketplaceWindowClosedReason,
  type MarketplaceWindowWatch,
} from "./window.js";
