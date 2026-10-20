// Esquema de la base de datos. Referencia conceptual: docs/02-modelo-datos.md.
// Los valores de los enums salen de @agentsales/core; nunca se repiten aquí.
import {
  ACTIVE_CONTENT_RUN_STATUSES,
  BRIEF_ORIGINS,
  BROKER_KINDS,
  CLOSE_REASONS,
  CONTENT_RUN_STATUSES,
  CONTENT_STATUSES,
  CURRENCIES,
  DEFAULT_LANGUAGE,
  FIELD_TYPES,
  IMPORT_RUN_STATUSES,
  INVITATION_PURPOSES,
  LISTING_SOURCES,
  LISTING_STATUSES,
  MEDIA_KINDS,
  MEDIA_ROLES,
  OPERATIONS,
  PLAN_RUN_STATUSES,
  PLATFORM_ACCOUNT_STATUSES,
  PLATFORMS,
  POST_KINDS,
  POST_SOURCES,
  POST_STATUSES,
  POST_UPLOAD_STATUSES,
  PUBLICATION_FORMATS,
  PUBLICATION_STATUSES,
  SESSION_CLIENTS,
  TERMINAL_PUBLICATION_STATUSES,
  USER_ROLES,
} from "@agentsales/core";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
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
export const userRoleEnum = pgEnum("user_role", USER_ROLES);
export const sessionClientEnum = pgEnum("session_client", SESSION_CLIENTS);
export const invitationPurposeEnum = pgEnum("invitation_purpose", INVITATION_PURPOSES);
export const brokerKindEnum = pgEnum("broker_kind", BROKER_KINDS);
// F9 (spec F9 §4.11): los posts, sus planes y sus subidas.
export const postStatusEnum = pgEnum("post_status", POST_STATUSES);
export const postKindEnum = pgEnum("post_kind", POST_KINDS);
export const postSourceEnum = pgEnum("post_source", POST_SOURCES);
export const briefOriginEnum = pgEnum("brief_origin", BRIEF_ORIGINS);
export const planRunStatusEnum = pgEnum("plan_run_status", PLAN_RUN_STATUSES);
export const postUploadStatusEnum = pgEnum("post_upload_status", POST_UPLOAD_STATUSES);

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
  /**
   * Corredor propio del operador (spec F7 §4.7, ADR-0023): usa `LLM_PROVIDER` (su plan) y el
   * formulario automático de Marketplace. La migración `0009` marca así a los que ya existían.
   */
  operatorOwned: boolean("operator_owned").notNull().default(false),
  /** Tope de gasto de IA del mes en dólares (spec F7 §4.7); `null` = sin tope. */
  llmMonthlyCapUsd: numeric("llm_monthly_cap_usd", { precision: 10, scale: 2 }),
  /**
   * `broker` o `brand` (F9, ADR-0029): qué ve el panel; no decide permisos. Que un aviso solo cuelgue
   * de un `broker` es una regla de core (`assertBrokerHoldsListings`), no un `CHECK`.
   */
  kind: brokerKindEnum("kind").notNull().default("broker"),
  ...timestamps,
});

// ── Usuarios y sesiones (spec F7 §4.12, ADR-0021) ───────────────────────

export const users = pgTable(
  "users",
  {
    id: id(),
    /** Siempre en minúsculas: el `CHECK` lo exige y el único compara así. */
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    role: userRoleEnum("role").notNull(),
    /** `null` si y solo si `role = 'admin'`. */
    brokerId: uuid("broker_id").references(() => brokers.id),
    /** `scrypt$N$r$p$sal$hash`; `null` hasta que acepta la invitación. Nunca sale del repositorio. */
    passwordHash: text("password_hash"),
    failedLogins: integer("failed_logins").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    // El doble factor (spec F8 §4.8, F8-T15): la clave cifrada con `SecretBox` (propósito `totp`),
    // desde cuándo está activa (`null` mientras se activa o si no lo usa) y el último paso de 30 s
    // usado (un código no sirve dos veces). Nunca salen del repositorio.
    totpSecretEncrypted: text("totp_secret_encrypted"),
    totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
    totpLastStep: bigint("totp_last_step", { mode: "number" }),
    ...timestamps,
  },
  (t) => [
    check("users_email_lowercase", sql`${t.email} = lower(${t.email})`),
    // Activo implica una clave guardada.
    check(
      "users_totp_enabled_secret",
      sql`${t.totpEnabledAt} IS NULL OR ${t.totpSecretEncrypted} IS NOT NULL`,
    ),
    check("users_role_broker", sql`(${t.role} = 'admin') = (${t.brokerId} IS NULL)`),
    index("users_broker_idx").on(t.brokerId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    /** SHA-256 del token; el token nunca se guarda. */
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    client: sessionClientEnum("client").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 del token del enlace. */
    tokenHash: text("token_hash").notNull().unique(),
    purpose: invitationPurposeEnum("purpose").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    /** `null` si lo generó `pnpm auth:admin`. */
    createdBy: uuid("created_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("invitations_user_idx").on(t.userId),
    // A lo más un enlace vigente por usuario: `issue` borra el anterior sin usar.
    uniqueIndex("invitations_one_open_per_user").on(t.userId).where(sql`"used_at" IS NULL`),
  ],
);

/** Los códigos de recuperación del doble factor (spec F8 §4.12): solo su hash, y si ya se usó. */
export const userRecoveryCodes = pgTable(
  "user_recovery_codes",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 del código normalizado (sin guiones, en mayúsculas). */
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("user_recovery_codes_user_hash").on(t.userId, t.codeHash)],
);

/**
 * El segundo paso de entrar (spec F8 §4.12): solo el hash del token; sirve una vez y vence a los
 * 5 min. La vigilancia de cada hora borra los vencidos.
 */
export const loginChallenges = pgTable(
  "login_challenges",
  {
    id: id(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("login_challenges_expires_idx").on(t.expiresAt)],
);

/** `state` del OAuth ya usados (spec F7 §4.12): el de Mercado Libre sirve una vez. */
export const oauthStatesUsed = pgTable("oauth_states_used", {
  nonceHash: text("nonce_hash").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/**
 * Los latidos del worker (spec F8 §4.10, T12): una fila por proceso, anotada cada minuto mientras
 * corre; `/health`, `doctor` y el panel dicen si está encendido.
 */
export const workerHeartbeats = pgTable(
  "worker_heartbeats",
  {
    processId: text("process_id").primaryKey(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    beatAt: timestamp("beat_at", { withTimezone: true }).notNull(),
    /** Cuándo se apagó en orden (SIGTERM); `null` mientras corre o si se cortó. */
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  },
  (t) => [index("worker_heartbeats_beat_idx").on(t.beatAt)],
);

/**
 * Los pedidos de borrado de Meta (spec F8 §4.11, T17): el código que se le devolvió y la página de
 * estado. Sin el `user_id` de Instagram (se borra lo que lo identifica), solo su hash.
 */
export const metaDeletionRequests = pgTable(
  "meta_deletion_requests",
  {
    code: text("code").primaryKey(),
    /** HMAC con clave del `user_id` (ADR-0027): para auditar los pedidos de una misma persona. */
    metaUserIdHash: text("meta_user_id_hash").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    /** Hoy siempre `completed`: el borrado se hace al recibir el pedido. */
    status: text("status").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    accountsAffected: integer("accounts_affected").notNull().default(0),
  },
  (t) => [check("meta_deletion_requests_status", sql`${t.status} = 'completed'`)],
);

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

// ── Contenido de marca (F9, ADR-0029 y ADR-0030; spec F9 §4.11) ──────────

/**
 * Un plan de ideas de la IA para un período (job `content.plan`, ADR-0030): se crea con `posts`
 * porque `posts.plan_run_id` la referencia; la lógica llega en F9-T20. Sus columnas de corrida
 * (`error`, `llm_usage`, `started_at`, `finished_at`) son como las de `content_runs`.
 */
export const planRuns = pgTable(
  "plan_runs",
  {
    id: id(),
    brokerId: uuid("broker_id")
      .notNull()
      .references(() => brokers.id),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    status: planRunStatusEnum("status").notNull().default("queued"),
    /** Lo pedido (redes, cuántas ideas…), sin secretos. */
    request: jsonb("request").notNull().default({}),
    /** Lo que propuso y lo que descartaron las verificaciones; `null` hasta que termina. */
    report: jsonb("report"),
    /** `{ code, message }` cuando `status = failed`. */
    error: jsonb("error"),
    /** `llmUsageSchema` (core): lo gastado en IA (spec F9 §4.12). */
    llmUsage: jsonb("llm_usage"),
    /** `SOCIAL_PROMPT_VERSION` con que corrió (ADR-0030, punto 6); `null` antes de llamar a la IA. */
    promptVersion: text("prompt_version"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("plan_runs_broker_created_idx").on(t.brokerId, t.createdAt)],
);

/**
 * Un post de marca (ADR-0029): un tema con un texto por red e idioma (`contents.post_id`) y, a
 * veces, medios (`media.post_id`). Cuelga de cualquier corredor o marca: que un aviso solo cuelgue
 * de un `broker` es una regla de core, no de la base.
 */
export const posts = pgTable(
  "posts",
  {
    id: id(),
    brokerId: uuid("broker_id")
      .notNull()
      .references(() => brokers.id),
    topic: text("topic").notNull(),
    /** Lo que el post debe decir; `null` si no tiene. */
    brief: text("brief"),
    /** Quién escribió el brief (ADR-0030, punto 1): solo el del operador es fuente de hechos. */
    briefOrigin: briefOriginEnum("brief_origin").notNull().default("operator"),
    kind: postKindEnum("kind").notNull(),
    status: postStatusEnum("status").notNull().default("draft"),
    source: postSourceEnum("source").notNull().default("manual"),
    /** La línea de contenido del perfil editorial (`pillars[].key`), si tiene. */
    pillar: text("pillar"),
    /** Cuándo se piensa publicar (la idea del plan o lo que fijó el operador). */
    plannedAt: timestamp("planned_at", { withTimezone: true }),
    planRunId: uuid("plan_run_id").references(() => planRuns.id),
    /** Quién lo creó o pidió el plan; `null` si se borró el usuario. */
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    /** El porqué de una idea de la IA. */
    rationale: text("rationale"),
    ...timestamps,
  },
  (t) => [index("posts_broker_status_planned_idx").on(t.brokerId, t.status, t.plannedAt)],
);

/** El perfil editorial de una marca (spec F9 §4.3): uno por corredor; lo llena el operador. */
export const editorialProfiles = pgTable("editorial_profiles", {
  brokerId: uuid("broker_id")
    .primaryKey()
    .references(() => brokers.id),
  /** `LANGUAGES` (core), sin repetir; el primero es el principal. */
  languages: text("languages")
    .array()
    .notNull()
    .default(sql.raw(`'{${DEFAULT_LANGUAGE}}'::text[]`)),
  /** A quién le habla, en una o dos frases. */
  audience: text("audience"),
  /** `[{ key, name, description, weight }]`. */
  pillars: jsonb("pillars").notNull().default([]),
  /** Los hechos que la IA puede afirmar (ADR-0030): lo que no está aquí no se afirma. */
  facts: text("facts").array().notNull().default(sql`'{}'::text[]`),
  avoid: text("avoid").array().notNull().default(sql`'{}'::text[]`),
  /** Posts por semana en cada red, días y horas preferidos y horas entre idiomas. */
  cadence: jsonb("cadence").notNull().default({}),
  /** Se suman a `brokers.fixed_hashtags`. */
  defaultHashtags: text("default_hashtags").array().notNull().default(sql`'{}'::text[]`),
  ...timestamps,
});

/**
 * Las subidas pendientes de un post (spec F9 §4.5, ADR-0025): la URL prefirmada se pidió y el
 * archivo puede no haber llegado. La limpieza periódica borra de R2 lo abandonado.
 */
export const postUploads = pgTable(
  "post_uploads",
  {
    id: id(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id),
    /** La clave de R2, bajo `posts/{postId}/…`. */
    objectPath: text("object_path").notNull(),
    expectedBytes: bigint("expected_bytes", { mode: "number" }).notNull(),
    status: postUploadStatusEnum("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    unique("post_uploads_object_path_unique").on(t.objectPath),
    index("post_uploads_post_idx").on(t.postId),
    // Las pendientes que vencen (la limpieza periódica).
    index("post_uploads_status_expires_idx").on(t.status, t.expiresAt),
  ],
);

export const media = pgTable(
  "media",
  {
    id: id(),
    /** `null` para los medios de un post y los del corredor (logo). */
    listingId: uuid("listing_id").references(() => listings.id),
    /** Desde F9 (ADR-0029): el post del medio; a lo más uno de `listing_id` y `post_id`. */
    postId: uuid("post_id").references(() => posts.id),
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
    // F9: el mismo archivo no se sube dos veces a un post.
    uniqueIndex("media_original_post_checksum_unique")
      .on(t.postId, t.checksum)
      .where(sql`"role" = 'original'`),
    // Un medio es de un aviso, de un post o de ninguno (el logo del corredor).
    check("media_at_most_one_subject", sql`num_nonnulls(${t.listingId}, ${t.postId}) <= 1`),
  ],
);

/**
 * `WHERE status IN (<activos>)`: una sola corrida activa por aviso.
 * `sql.raw` es seguro aquí: los valores son literales constantes de `core`, nunca entrada externa.
 */
const activeContentRun = sql.raw(
  `"status" IN (${ACTIVE_CONTENT_RUN_STATUSES.map((status) => `'${status}'`).join(", ")})`,
);

/**
 * Corridas de contenido (job `content.prepare`, ADR-0012; spec F2 §4.3). Desde F9 (ADR-0029), de
 * un aviso o de un post: exactamente uno de `listing_id` y `post_id`.
 */
export const contentRuns = pgTable(
  "content_runs",
  {
    id: id(),
    listingId: uuid("listing_id").references(() => listings.id),
    postId: uuid("post_id").references(() => posts.id),
    status: contentRunStatusEnum("status").notNull().default("queued"),
    /** Si la corrida genera textos (`false`: solo medios y renders). */
    texts: boolean("texts").notNull().default(true),
    /** Etapa en curso (`CONTENT_RUN_STAGES`); `null` antes de empezar. */
    stage: text("stage"),
    /** `contentRunReportSchema` (core); `null` hasta que la corrida termina. */
    report: jsonb("report"),
    /** `{ code, message }` cuando `status = failed`. */
    error: jsonb("error"),
    /** `llmUsageSchema` (core): lo gastado en IA, sumado por llamada (spec F7 §4.7). */
    llmUsage: jsonb("llm_usage"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /**
     * Desde F8-T12 (spec F8 §4.10): cuándo se resolvió el `auto_publish` de una corrida `succeeded`
     * (se intentó, no aplicaba o se retomó al arrancar). `null` en una terminada: quedó cortado.
     */
    autoPublishDoneAt: timestamp("auto_publish_done_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("content_runs_one_active_per_listing").on(t.listingId).where(activeContentRun),
    index("content_runs_listing_created_idx").on(t.listingId, t.createdAt),
    uniqueIndex("content_runs_one_active_per_post").on(t.postId).where(activeContentRun),
    index("content_runs_post_created_idx").on(t.postId, t.createdAt),
    check("content_runs_one_subject", sql`num_nonnulls(${t.listingId}, ${t.postId}) = 1`),
  ],
);

/** Un texto por canal (y, desde F9, por idioma) de un aviso o de un post (ADR-0029). */
export const contents = pgTable(
  "contents",
  {
    id: id(),
    listingId: uuid("listing_id").references(() => listings.id),
    postId: uuid("post_id").references(() => posts.id),
    /** Corrida que lo generó (ADR-0012). */
    contentRunId: uuid("content_run_id")
      .notNull()
      .references(() => contentRuns.id),
    platform: platformEnum("platform").notNull(),
    /** `LANGUAGES` (core); lo anterior a F9 es español. */
    language: text("language").notNull().default(DEFAULT_LANGUAGE),
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
    // Un texto por canal, idioma y corrida: un intento solapado del job no duplica (spec F2 §4.4).
    // Los textos de un aviso son todos `es`: para ellos equivale al único de antes (canal y corrida).
    unique("contents_run_platform_language_unique").on(t.contentRunId, t.platform, t.language),
    // El vigente de cada canal es el más reciente.
    index("contents_listing_platform_created_idx").on(t.listingId, t.platform, t.createdAt),
    index("contents_post_platform_created_idx").on(t.postId, t.platform, t.createdAt),
    check("contents_one_subject", sql`num_nonnulls(${t.listingId}, ${t.postId}) = 1`),
  ],
);

/**
 * `WHERE status NOT IN (<terminales>)`: todo estado no terminal cuenta como activo.
 * `sql.raw` es seguro aquí: los valores son literales constantes de `core`, nunca entrada externa.
 */
const activePublication = sql.raw(
  `"status" NOT IN (${TERMINAL_PUBLICATION_STATUSES.map((status) => `'${status}'`).join(", ")})`,
);

/** Una publicación de un aviso o, desde F9, de un post (ADR-0029): exactamente uno de los dos. */
export const publications = pgTable(
  "publications",
  {
    id: id(),
    listingId: uuid("listing_id").references(() => listings.id),
    postId: uuid("post_id").references(() => posts.id),
    platformAccountId: uuid("platform_account_id")
      .notNull()
      .references(() => platformAccounts.id),
    platform: platformEnum("platform").notNull(),
    /** `post` (carrusel o imagen suelta) o `reel` (ADR-0014). */
    format: publicationFormatEnum("format").notNull(),
    /** El idioma de su texto (`LANGUAGES`, core): dos idiomas son dos publicaciones (spec F9 §4.4). */
    language: text("language").notNull().default(DEFAULT_LANGUAGE),
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
    /** La publicación de Portal que esta republica (ADR-0020, spec F6 §4.7). */
    relistedFrom: uuid("relisted_from").references((): AnyPgColumn => publications.id),
    /** El costo estimado en dólares (spec F9 §4.12): hoy solo X; `null` si la red no cobra. */
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }),
    ...timestamps,
  },
  (t) => [
    // Una activa por aviso, cuenta y formato: el carrusel y el reel conviven (ADR-0014).
    uniqueIndex("publications_one_active_per_format")
      .on(t.listingId, t.platformAccountId, t.format)
      .where(activePublication),
    index("publications_listing_idx").on(t.listingId),
    // F9: una activa por post, cuenta, formato e idioma (dos idiomas son dos publicaciones).
    uniqueIndex("publications_one_active_per_post_format")
      .on(t.postId, t.platformAccountId, t.format, t.language)
      .where(activePublication),
    index("publications_post_idx").on(t.postId),
    check("publications_one_subject", sql`num_nonnulls(${t.listingId}, ${t.postId}) = 1`),
    // Las programadas que vencen (el disparo de cada minuto, spec F6 §4.4).
    index("publications_scheduled_due").on(t.scheduledAt).where(sql`"status" = 'scheduled'`),
    // Una sola republicación por publicación, sin contar las descartadas (spec F6 §4.12).
    uniqueIndex("publications_relisted_from_unique")
      .on(t.relistedFrom)
      .where(sql`"relisted_from" IS NOT NULL AND "status" <> 'cancelled'`),
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
    /** La persona que lo hizo (spec F7 §4.3); `null` en lo del sistema y lo anterior a F7. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
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

export const importRuns = pgTable(
  "import_runs",
  {
    id: id(),
    /** `null` hasta que el job lee la hoja Corredor. */
    brokerId: uuid("broker_id").references(() => brokers.id),
    status: importRunStatusEnum("status").notNull().default("queued"),
    dryRun: boolean("dry_run").notNull().default(false),
    /**
     * `importRunInputSchema` (core): las claves de R2 de la planilla y los medios (spec F8 §4.12), o
     * las rutas locales de antes de F8; sin secretos. El job solo recibe el id.
     */
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
  },
  // Cerrar las que nadie terminó de subir (`awaiting_upload` de más de 24 h, spec F8 §4.4).
  (t) => [index("import_runs_status_created_at_idx").on(t.status, t.createdAt)],
);
