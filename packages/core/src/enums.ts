// Valores de dominio compartidos. Son tuplas `as const` para usarlas directo en
// `z.enum()` y en `pgEnum()` de Drizzle. Fuente: docs/02-modelo-datos.md.

export const PLATFORMS = ["instagram", "portal_inmobiliario", "fb_marketplace"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const LISTING_STATUSES = [
  "draft",
  "ready",
  "active",
  "paused",
  "closed",
  "archived",
] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/** Estados de una publicación. Transiciones en `publication-state.ts`. */
export const PUBLICATION_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "scheduled",
  "publishing",
  "awaiting_manual_confirm",
  "published",
  "failed",
  "paused",
  "unpublished",
  "cancelled",
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export const CURRENCIES = ["UF", "CLP"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const OPERATIONS = ["sale", "rent"] as const;
export type Operation = (typeof OPERATIONS)[number];

/** `dry-run` es el modo por defecto: no publica nada de verdad. */
export const PUBLISH_MODES = ["dry-run", "live"] as const;
export type PublishMode = (typeof PUBLISH_MODES)[number];

/** Proveedores de IA (ADR-0003). */
export const LLM_PROVIDERS = ["claude-cli", "anthropic-api", "fake"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];
