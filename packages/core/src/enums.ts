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

export const PLATFORM_ACCOUNT_STATUSES = ["connected", "expired", "revoked", "error"] as const;
export type PlatformAccountStatus = (typeof PLATFORM_ACCOUNT_STATUSES)[number];

/** Tipos de un campo configurable (`field_definitions`). */
export const FIELD_TYPES = ["text", "number", "enum", "boolean", "date", "url", "list"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const MEDIA_KINDS = ["image", "video"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MEDIA_ROLES = ["original", "processed", "rendered"] as const;
export type MediaRole = (typeof MEDIA_ROLES)[number];

export const CONTENT_STATUSES = ["draft", "edited", "approved"] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/** Origen de un aviso; también de una carga (`import_runs`). */
export const LISTING_SOURCES = ["xlsx", "google_sheets", "manual", "chat"] as const;
export type ListingSource = (typeof LISTING_SOURCES)[number];

export const CLOSE_REASONS = ["sold", "rented", "withdrawn"] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

/** Estado de una carga (`import_runs`, job `import.run`). `succeeded` y `failed` son terminales. */
export const IMPORT_RUN_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type ImportRunStatus = (typeof IMPORT_RUN_STATUSES)[number];
