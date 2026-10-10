/**
 * Facebook Marketplace con Playwright (spec F5, ADR-0017). Subruta propia
 * (`@agentsales/publishers/marketplace`): solo la importa el worker, así la API no carga Playwright.
 */
export { MARKETPLACE_ERRORS } from "./errors.js";
export { captureFormEvidence, type MarketplaceEvidence, stopRecord } from "./evidence.js";
export {
  classifyPage,
  type MarketplacePageKind,
  pathOf,
  type RequireFormOptions,
  requireForm,
  stopErrorOf,
} from "./guard.js";
export {
  type MarketplaceProfile,
  marketplaceProfileDir,
  type OpenMarketplaceProfileOptions,
  openMarketplaceProfile,
} from "./profile.js";
export {
  FACEBOOK_HOME_URL,
  FACEBOOK_ORIGIN,
  MARKETPLACE_FORM_URL,
  SESSION_COOKIE,
} from "./selectors.js";
export {
  createMarketplaceWindow,
  type MarketplaceWindow,
  type MarketplaceWindowClosedReason,
  type MarketplaceWindowWatch,
} from "./window.js";
