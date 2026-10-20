// Valores de dominio compartidos. Son tuplas `as const` para usarlas directo en
// `z.enum()` y en `pgEnum()` de Drizzle. Fuente: docs/02-modelo-datos.md.

/**
 * Las plataformas. Desde F9 (ADR-0029) suman las redes del contenido de marca: `x`, `linkedin`,
 * `discord` y `tiktok` (una sola migración, la `0014`, con `ALTER TYPE … ADD VALUE`). Una plataforma
 * sin publisher todavía no publica: el registro de publishers es parcial (`Partial<Record<…>>`).
 */
export const PLATFORMS = [
  "instagram",
  "portal_inmobiliario",
  "fb_marketplace",
  "x",
  "linkedin",
  "discord",
  "tiktok",
] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * Las plataformas de los avisos (F2 a F8): los textos de un aviso, el seguimiento y la publicación
 * de una propiedad recorren solo estas, en este orden. Las redes de F9 son de los posts.
 */
export const LISTING_PLATFORMS = [
  "instagram",
  "portal_inmobiliario",
  "fb_marketplace",
] as const satisfies readonly Platform[];
export type ListingPlatform = (typeof LISTING_PLATFORMS)[number];

export const isListingPlatform = (platform: Platform): platform is ListingPlatform =>
  (LISTING_PLATFORMS as readonly Platform[]).includes(platform);

/**
 * Los nombres cortos de los canales para la CLI (`--platform portal`, spec F2 §4.7): se traducen a
 * `PLATFORMS` solo aquí.
 */
export const PLATFORM_SHORT_NAMES = {
  instagram: "instagram",
  portal: "portal_inmobiliario",
  marketplace: "fb_marketplace",
  x: "x",
  linkedin: "linkedin",
  discord: "discord",
  tiktok: "tiktok",
} as const satisfies Record<string, Platform>;
export type PlatformShortName = keyof typeof PLATFORM_SHORT_NAMES;

/**
 * Qué es un corredor (`brokers.kind`, ADR-0029 puntos 5 y 13): `broker` (el de siempre, con
 * propiedades) o `brand` (una marca que solo publica contenido). Solo dice qué ve el panel y **no
 * decide permisos**; podrá sumar valores (`org`, `office`) con `ALTER TYPE … ADD VALUE`.
 */
export const BROKER_KINDS = ["broker", "brand"] as const;
export type BrokerKind = (typeof BROKER_KINDS)[number];

export const LISTING_STATUSES = [
  "draft",
  "ready",
  "active",
  "paused",
  "closed",
  "archived",
] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/**
 * Estados de una publicación. Transiciones en `publication-state.ts`. Desde ADR-0014 nace en
 * `approved` (lo que se aprueba es el texto de su canal): ya no existen `draft` ni `pending_approval`.
 * `outcome_unknown` (F9, ADR-0029 punto 8): la red pudo haber publicado y no se sabe; va al final
 * porque la migración lo agrega con `ALTER TYPE … ADD VALUE`.
 */
export const PUBLICATION_STATUSES = [
  "approved",
  "scheduled",
  "publishing",
  "awaiting_manual_confirm",
  "published",
  "failed",
  "paused",
  "unpublished",
  "cancelled",
  "outcome_unknown",
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

/**
 * Formato de una publicación (ADR-0014): una por aviso, cuenta y formato. En Instagram, `post` es el
 * carrusel (o una imagen suelta) y `reel` el reel; Portal y Marketplace solo usan `post`.
 */
export const PUBLICATION_FORMATS = ["post", "reel"] as const;
export type PublicationFormat = (typeof PUBLICATION_FORMATS)[number];

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

/**
 * Estado de una carga (`import_runs`, job `import.run`). `succeeded` y `failed` son terminales.
 * `awaiting_upload` (spec F8 §4.4): pedida, con sus URLs de subida, mientras el panel o la CLI
 * suben los archivos a R2; `startImport` la pasa a `queued`.
 */
export const IMPORT_RUN_STATUSES = [
  "awaiting_upload",
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;
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

// ── Contenido de marca (F9, ADR-0029 y ADR-0030; spec F9 §4.2 y §4.11) ──────────────────────────

/**
 * Estado de un post (spec F9 §4.2): `idea` (propuesta de la IA, sin textos), `draft` (aceptado o
 * creado a mano), `ready` (al menos un texto aprobado) y `archived` (descartado o terminado).
 */
export const POST_STATUSES = ["idea", "draft", "ready", "archived"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/** Qué lleva un post: solo texto, una imagen, un carrusel o un video. */
export const POST_KINDS = ["text", "image", "carousel", "video"] as const;
export type PostKind = (typeof POST_KINDS)[number];

/** De dónde salió un post: a mano o de un plan de la IA (`plan_runs`). */
export const POST_SOURCES = ["manual", "ai"] as const;
export type PostSource = (typeof POST_SOURCES)[number];

/**
 * Quién escribió el brief de un post (ADR-0030, punto 1): solo el del operador es fuente de hechos.
 * Cuando el operador edita un brief de la IA, pasa a `operator`.
 */
export const BRIEF_ORIGINS = ["operator", "ai"] as const;
export type BriefOrigin = (typeof BRIEF_ORIGINS)[number];

/**
 * Estado de un plan de ideas (`plan_runs`, job `content.plan`; ADR-0030). Mismos valores que las
 * corridas de contenido, en su propio enum de Postgres. `succeeded` y `failed` son terminales.
 */
export const PLAN_RUN_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type PlanRunStatus = (typeof PLAN_RUN_STATUSES)[number];

/**
 * Estado de una subida pendiente de un post (`post_uploads`, spec F9 §4.5, ADR-0025): `pending`
 * (con su URL prefirmada), `completed` (subida y registrada como medio) o `abandoned` (vencida; la
 * limpieza periódica la borra de R2).
 */
export const POST_UPLOAD_STATUSES = ["pending", "completed", "abandoned"] as const;
export type PostUploadStatus = (typeof POST_UPLOAD_STATUSES)[number];

/**
 * Idiomas de un texto y de una publicación (`contents.language`, `publications.language`) y del
 * perfil editorial (`editorial_profiles.languages`, spec F9 §4.3). En la base son texto: se validan
 * aquí. Lo anterior a F9 es español (`DEFAULT_LANGUAGE`).
 */
export const LANGUAGES = ["es", "en"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE = "es" satisfies Language;
