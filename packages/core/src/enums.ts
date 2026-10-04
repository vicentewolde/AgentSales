// Valores de dominio compartidos. Son tuplas `as const` para usarlas directo en
// `z.enum()` y en `pgEnum()` de Drizzle. Fuente: docs/02-modelo-datos.md.

export const PLATFORMS = ["instagram", "portal_inmobiliario", "fb_marketplace"] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * Los nombres cortos de los canales para la CLI (`--platform portal`, spec F2 §4.7): se traducen a
 * `PLATFORMS` solo aquí.
 */
export const PLATFORM_SHORT_NAMES = {
  instagram: "instagram",
  portal: "portal_inmobiliario",
  marketplace: "fb_marketplace",
} as const satisfies Record<string, Platform>;
export type PlatformShortName = keyof typeof PLATFORM_SHORT_NAMES;

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

/**
 * Variantes de un original (`role = processed`, spec F2 §4.2): miniatura para el panel, recortes
 * por canal y el reel. Una vigente por original y variante.
 */
export const PROCESSED_MEDIA_VARIANTS = ["thumb", "ig_4x5", "pi_4x3", "ig_reel"] as const;
export type ProcessedMediaVariant = (typeof PROCESSED_MEDIA_VARIANTS)[number];

/** Renders de plantillas (`role = rendered`): portada y ficha del carrusel. Uno por aviso. */
export const RENDERED_MEDIA_VARIANTS = ["cover", "spec_sheet"] as const;
export type RenderedMediaVariant = (typeof RENDERED_MEDIA_VARIANTS)[number];

/** `media.variant`: texto en la base, validado con esta tupla al leer. */
export const MEDIA_VARIANTS = [...PROCESSED_MEDIA_VARIANTS, ...RENDERED_MEDIA_VARIANTS] as const;
export type MediaVariant = (typeof MEDIA_VARIANTS)[number];

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

/** Estados finales de una carga: el job no la vuelve a procesar, y la CLI y el panel dejan de sondear. */
export const TERMINAL_IMPORT_RUN_STATUSES = [
  "succeeded",
  "failed",
] as const satisfies readonly ImportRunStatus[];

export const isTerminalImportRun = (status: ImportRunStatus): boolean =>
  (TERMINAL_IMPORT_RUN_STATUSES as readonly ImportRunStatus[]).includes(status);

/**
 * Estado de una corrida de contenido (`content_runs`, job `content.prepare`; ADR-0012). Mismos
 * valores que las cargas, en su propio enum de Postgres. `succeeded` y `failed` son terminales.
 */
export const CONTENT_RUN_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type ContentRunStatus = (typeof CONTENT_RUN_STATUSES)[number];

/** Corridas en curso: una sola por aviso (único parcial de `content_runs`). */
export const ACTIVE_CONTENT_RUN_STATUSES = [
  "queued",
  "running",
] as const satisfies readonly ContentRunStatus[];

export const isTerminalContentRun = (status: ContentRunStatus): boolean =>
  !(ACTIVE_CONTENT_RUN_STATUSES as readonly ContentRunStatus[]).includes(status);

/** Etapas de una corrida de contenido, en orden (spec F2 §4.4): para mostrar el avance. */
export const CONTENT_RUN_STAGES = ["media", "renders", "reel", "texts"] as const;
export type ContentRunStage = (typeof CONTENT_RUN_STAGES)[number];

/** Categoría de un aviso (ADR-0006). `product` llega después del MVP. */
export const LISTING_CATEGORIES = ["real_estate"] as const;
export type ListingCategory = (typeof LISTING_CATEGORIES)[number];
