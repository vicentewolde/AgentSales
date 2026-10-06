// Esquema de la base de datos. Referencia conceptual: docs/02-modelo-datos.md.
// Los valores de los enums salen de @agentsales/core; nunca se repiten aquí.
import {
  ACTIVE_CONTENT_RUN_STATUSES,
  CLOSE_REASONS,
  CONTENT_RUN_STATUSES,
  CONTENT_STATUSES,
  CURRENCIES,
  FIELD_TYPES,
  IMPORT_RUN_STATUSES,
  LISTING_SOURCES,
  LISTING_STATUSES,
  MEDIA_KINDS,
  MEDIA_ROLES,
  OPERATIONS,
  PLATFORM_ACCOUNT_STATUSES,
  PLATFORMS,
  PUBLICATION_FORMATS,
  PUBLICATION_STATUSES,
  TERMINAL_PUBLICATION_STATUSES,
} from "@agentsales/core";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ── Enums ────────────────────────────────────────────────────────────────

export const platformEnum = pgEnum("platform", PLATFORMS);
export const platformAccountStatusEnum = pgEnum(
  "platform_account_status",
  PLATFORM_ACCOUNT_STATUSES,
);
export const fieldTypeEnum = pgEnum("field_type", FIELD_TYPES);
export const operationEnum = pgEnum("operation", OPERATIONS);
export const listingStatusEnum = pgEnum("listing_status", LISTING_STATUSES);
export const closeReasonEnum = pgEnum("close_reason", CLOSE_REASONS);
export const currencyEnum = pgEnum("currency", CURRENCIES);
export const listingSourceEnum = pgEnum("listing_source", LISTING_SOURCES);
export const mediaKindEnum = pgEnum("media_kind", MEDIA_KINDS);
export const mediaRoleEnum = pgEnum("media_role", MEDIA_ROLES);
export const contentStatusEnum = pgEnum("content_status", CONTENT_STATUSES);
export const publicationStatusEnum = pgEnum("publication_status", PUBLICATION_STATUSES);
export const publicationFormatEnum = pgEnum("publication_format", PUBLICATION_FORMATS);
export const importRunStatusEnum = pgEnum("import_run_status", IMPORT_RUN_STATUSES);
export const contentRunStatusEnum = pgEnum("content_run_status", CONTENT_RUN_STATUSES);

// ── Columnas comunes ─────────────────────────────────────────────────────

const id = () => uuid("id").primaryKey().defaultRandom();

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    // La hora de la base, como `defaultNow()`: con `new Date()` (milisegundos) un aviso tocado en
    // el mismo milisegundo en que se creó otro (microsegundos) quedaba como "más antiguo".
    .$onUpdate(() => sql`now()`),
};

// ── Tablas ───────────────────────────────────────────────────────────────

export const brokers = pgTable("brokers", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  brandName: text("brand_name").notNull(),
  logoMediaId: uuid("logo_media_id").references((): AnyPgColumn => media.id),
  primaryColor: text("primary_color").notNull(),
  secondaryColor: text("secondary_color").notNull(),
  whatsapp: text("whatsapp"),
  email: text("email"),
  instagramHandle: text("instagram_handle"),
  website: text("website"),
  tone: text("tone"),
  fixedHashtags: text("fixed_hashtags").array().notNull().default(sql`'{}'::text[]`),
  autoPublish: boolean("auto_publish").notNull().default(false),
  ...timestamps,
});

export const platformAccounts = pgTable(
  "platform_accounts",
  {
    id: id(),
    brokerId: uuid("broker_id")
      .notNull()
      .references(() => brokers.id),
    platform: platformEnum("platform").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    displayName: text("display_name").notNull(),
    credentialsEncrypted: text("credentials_encrypted"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    status: platformAccountStatusEnum("status").notNull(),
    meta: jsonb("meta").notNull().default({}),
    ...timestamps,
  },
  (t) => [unique().on(t.brokerId, t.platform, t.externalAccountId)],
);

export const fieldDefinitions = pgTable(
  "field_definitions",
  {
    id: id(),
    /** `null` = definición global. */
    brokerId: uuid("broker_id").references(() => brokers.id),
    category: text("category").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    type: fieldTypeEnum("type").notNull(),
    required: boolean("required").notNull().default(false),
    options: jsonb("options"),
    sourceColumn: text("source_column").notNull(),
    isCore: boolean("is_core").notNull().default(false),
    /** Rango de un campo `number`, con los extremos incluidos; `null` = sin tope (spec F2 §4.3). */
    minValue: numeric("min_value", { mode: "number" }),
    maxValue: numeric("max_value", { mode: "number" }),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    // Una definición por `key` y categoría, global (`broker_id` null) o del corredor: destino del
    // upsert del seed. NULLS NOT DISTINCT hace que dos globales con el mismo `key` choquen (PG ≥ 15).
    unique("field_definitions_broker_category_key_unique")
      .on(t.brokerId, t.category, t.key)
      .nullsNotDistinct(),
  ],
);

export const listings = pgTable(
  "listings",
  {
    id: id(),
    brokerId: uuid("broker_id")
      .notNull()
      .references(() => brokers.id),
    externalRef: text("external_ref").notNull(),
    category: text("category").notNull(),
    operation: operationEnum("operation"),
    propertyType: text("property_type"),
    status: listingStatusEnum("status").notNull().default("draft"),
    closeReason: closeReasonEnum("close_reason"),
    priceAmount: numeric("price_amount", { precision: 14, scale: 2 }).notNull(),
    priceCurrency: currencyEnum("price_currency").notNull(),
    region: text("region"),
    comuna: text("comuna"),
    address: text("address"),
    unitNumber: text("unit_number"),
    showExactAddress: boolean("show_exact_address").notNull().default(false),
    attributes: jsonb("attributes").notNull().default({}),
    highlights: text("highlights"),
    /** Nunca se envía a la IA ni a las plataformas. */
    internalNotes: text("internal_notes"),
    source: listingSourceEnum("source").notNull(),
    sourceHash: text("source_hash").notNull(),
    ...timestamps,
  },
  (t) => [unique().on(t.brokerId, t.externalRef)],
);

export const media = pgTable(
  "media",
  {
    id: id(),
    /** `null` para medios del corredor (logo). */
    listingId: uuid("listing_id").references(() => listings.id),
    brokerId: uuid("broker_id")
      .notNull()
      .references(() => brokers.id),
    kind: mediaKindEnum("kind").notNull(),
    role: mediaRoleEnum("role").notNull(),
    variant: text("variant"),
    parentMediaId: uuid("parent_media_id").references((): AnyPgColumn => media.id),
    storagePath: text("storage_path").notNull(),
    mime: text("mime").notNull(),
    width: integer("width"),
    height: integer("height"),
    durationS: numeric("duration_s", { precision: 10, scale: 3, mode: "number" }),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    checksum: text("checksum").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isCover: boolean("is_cover").notNull().default(false),
    aiMetadata: jsonb("ai_metadata"),
    ...timestamps,
  },
  (t) => [
    // El mismo archivo no se sube dos veces a la misma propiedad (deduplicación por sha256).
    uniqueIndex("media_original_listing_checksum_unique")
      .on(t.listingId, t.checksum)
      .where(sql`"role" = 'original'`),
    // Cubre también el logo (`listing_id` null), que el único parcial no alcanza.
    unique("media_storage_path_unique").on(t.storagePath),
    // Una variante vigente por original y variante, y un render por aviso y variante (F2-T03).
    uniqueIndex("media_processed_parent_variant_unique")
      .on(t.parentMediaId, t.variant)
      .where(sql`"role" = 'processed'`),
    uniqueIndex("media_rendered_listing_variant_unique")
      .on(t.listingId, t.variant)
      .where(sql`"role" = 'rendered'`),
  ],
);

/**
 * `WHERE status IN (<activos>)`: una sola corrida activa por aviso.
 * `sql.raw` es seguro aquí: los valores son literales constantes de `core`, nunca entrada externa.
 */
const activeContentRun = sql.raw(
  `"status" IN (${ACTIVE_CONTENT_RUN_STATUSES.map((status) => `'${status}'`).join(", ")})`,
);

/** Corridas de contenido (job `content.prepare`, ADR-0012; spec F2 §4.3). */
export const contentRuns = pgTable(
  "content_runs",
  {
    id: id(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id),
    status: contentRunStatusEnum("status").notNull().default("queued"),
    /** Si la corrida genera textos (`false`: solo medios y renders). */
    texts: boolean("texts").notNull().default(true),
    /** Etapa en curso (`CONTENT_RUN_STAGES`); `null` antes de empezar. */
    stage: text("stage"),
    /** `contentRunReportSchema` (core); `null` hasta que la corrida termina. */
    report: jsonb("report"),
    /** `{ code, message }` cuando `status = failed`. */
    error: jsonb("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("content_runs_one_active_per_listing").on(t.listingId).where(activeContentRun),
    index("content_runs_listing_created_idx").on(t.listingId, t.createdAt),
  ],
);

export const contents = pgTable(
  "contents",
  {
    id: id(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id),
    /** Corrida que lo generó (ADR-0012). */
    contentRunId: uuid("content_run_id")
      .notNull()
      .references(() => contentRuns.id),
    platform: platformEnum("platform").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    hashtags: text("hashtags").array().notNull().default(sql`'{}'::text[]`),
    status: contentStatusEnum("status").notNull().default("draft"),
    llmProvider: text("llm_provider").notNull(),
    llmModel: text("llm_model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    rawOutput: jsonb("raw_output").notNull(),
    ...timestamps,
  },
  (t) => [
    // Un texto por canal y corrida: un intento solapado del job no duplica (spec F2 §4.4).
    unique("contents_run_platform_unique").on(t.contentRunId, t.platform),
    // El vigente de cada canal es el más reciente.
    index("contents_listing_platform_created_idx").on(t.listingId, t.platform, t.createdAt),
  ],
);

/**
 * `WHERE status NOT IN (<terminales>)`: todo estado no terminal cuenta como activo.
 * `sql.raw` es seguro aquí: los valores son literales constantes de `core`, nunca entrada externa.
 */
const activePublication = sql.raw(
  `"status" NOT IN (${TERMINAL_PUBLICATION_STATUSES.map((status) => `'${status}'`).join(", ")})`,
);

export const publications = pgTable(
  "publications",
  {
    id: id(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id),
    platformAccountId: uuid("platform_account_id")
      .notNull()
      .references(() => platformAccounts.id),
    platform: platformEnum("platform").notNull(),
    /** `post` (carrusel o imagen suelta) o `reel` (ADR-0014). */
    format: publicationFormatEnum("format").notNull(),
    contentId: uuid("content_id")
      .notNull()
      .references(() => contents.id),
    mediaIds: uuid("media_ids").array().notNull().default(sql`'{}'::uuid[]`),
    status: publicationStatusEnum("status").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    attempts: integer("attempts").notNull().default(0),
    /** `{ code, message, retriable }`. */
    lastError: jsonb("last_error"),
    dryRun: boolean("dry_run").notNull(),
    /** Lo que el publisher ya creó en la plataforma, para retomar sin publicar dos veces (ADR-0014). */
    progress: jsonb("progress"),
    /** Lo último que informó la plataforma (`remoteStateSchema`, ADR-0015). */
    remoteState: jsonb("remote_state"),
    /** `source_hash` del aviso al nacer la publicación (ADR-0015, spec F4 §4.6). */
    listingSourceHash: text("listing_source_hash"),
    ...timestamps,
  },
  (t) => [
    // Una activa por aviso, cuenta y formato: el carrusel y el reel conviven (ADR-0014).
    uniqueIndex("publications_one_active_per_format")
      .on(t.listingId, t.platformAccountId, t.format)
      .where(activePublication),
    index("publications_listing_idx").on(t.listingId),
  ],
);

/** Bitácora inmutable: solo `created_at`. */
export const publicationEvents = pgTable(
  "publication_events",
  {
    id: id(),
    publicationId: uuid("publication_id")
      .notNull()
      .references(() => publications.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    actor: text("actor").notNull(),
    /** Sin secretos. */
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("publication_events_publication_created_idx").on(t.publicationId, t.createdAt)],
);

/**
 * Catálogo de una plataforma (ADR-0015, spec F4 §4.4): datos públicos que solo se leen con token
 * (en Mercado Libre, categorías, atributos y ubicaciones), con 7 días de vida (`fetched_at`).
 */
export const platformCatalog = pgTable(
  "platform_catalog",
  {
    platform: platformEnum("platform").notNull(),
    /** `category:<id>`, `attributes:<hoja>` o `location:<id>`. */
    key: text("key").notNull(),
    data: jsonb("data").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.platform, t.key] })],
);

export const importRuns = pgTable("import_runs", {
  id: id(),
  /** `null` hasta que el job lee la hoja Corredor. */
  brokerId: uuid("broker_id").references(() => brokers.id),
  status: importRunStatusEnum("status").notNull().default("queued"),
  dryRun: boolean("dry_run").notNull().default(false),
  /** Rutas absolutas de entrada y broker pedido; sin secretos. El job solo recibe el id. */
  input: jsonb("input").notNull().default({}),
  /** `{ code, message }` cuando `status = failed`. */
  error: jsonb("error"),
  source: listingSourceEnum("source").notNull(),
  fileName: text("file_name").notNull(),
  rowsTotal: integer("rows_total").notNull().default(0),
  rowsCreated: integer("rows_created").notNull().default(0),
  rowsUpdated: integer("rows_updated").notNull().default(0),
  rowsSkipped: integer("rows_skipped").notNull().default(0),
  rowsFailed: integer("rows_failed").notNull().default(0),
  /** `importReportSchema` (core); `null` hasta que `importListings` registra su resultado. */
  report: jsonb("report"),
  /** Se fija al pasar a `running`. */
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  ...timestamps,
});
