CREATE TYPE "public"."close_reason" AS ENUM('sold', 'rented', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('draft', 'edited', 'approved');--> statement-breakpoint
CREATE TYPE "public"."currency" AS ENUM('UF', 'CLP');--> statement-breakpoint
CREATE TYPE "public"."field_type" AS ENUM('text', 'number', 'enum', 'boolean', 'date', 'url', 'list');--> statement-breakpoint
CREATE TYPE "public"."listing_source" AS ENUM('xlsx', 'google_sheets', 'manual', 'chat');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('draft', 'ready', 'active', 'paused', 'closed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TYPE "public"."media_role" AS ENUM('original', 'processed', 'rendered');--> statement-breakpoint
CREATE TYPE "public"."operation" AS ENUM('sale', 'rent');--> statement-breakpoint
CREATE TYPE "public"."platform_account_status" AS ENUM('connected', 'expired', 'revoked', 'error');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('instagram', 'portal_inmobiliario', 'fb_marketplace');--> statement-breakpoint
CREATE TYPE "public"."publication_status" AS ENUM('draft', 'pending_approval', 'approved', 'scheduled', 'publishing', 'awaiting_manual_confirm', 'published', 'failed', 'paused', 'unpublished', 'cancelled');--> statement-breakpoint
CREATE TABLE "brokers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"brand_name" text NOT NULL,
	"logo_media_id" uuid,
	"primary_color" text NOT NULL,
	"secondary_color" text NOT NULL,
	"whatsapp" text,
	"email" text,
	"instagram_handle" text,
	"website" text,
	"tone" text,
	"fixed_hashtags" text[] DEFAULT '{}'::text[] NOT NULL,
	"auto_publish" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brokers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "contents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"hashtags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"llm_provider" text NOT NULL,
	"llm_model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"raw_output" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid,
	"category" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" "field_type" NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"options" jsonb,
	"source_column" text NOT NULL,
	"is_core" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid NOT NULL,
	"source" "listing_source" NOT NULL,
	"file_name" text NOT NULL,
	"rows_total" integer DEFAULT 0 NOT NULL,
	"rows_created" integer DEFAULT 0 NOT NULL,
	"rows_updated" integer DEFAULT 0 NOT NULL,
	"rows_skipped" integer DEFAULT 0 NOT NULL,
	"rows_failed" integer DEFAULT 0 NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"category" text NOT NULL,
	"operation" "operation",
	"property_type" text,
	"status" "listing_status" DEFAULT 'draft' NOT NULL,
	"close_reason" "close_reason",
	"price_amount" numeric(14, 2) NOT NULL,
	"price_currency" "currency" NOT NULL,
	"region" text,
	"comuna" text,
	"address" text,
	"unit_number" text,
	"show_exact_address" boolean DEFAULT false NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"highlights" text,
	"internal_notes" text,
	"source" "listing_source" NOT NULL,
	"source_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listings_broker_id_external_ref_unique" UNIQUE("broker_id","external_ref")
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid,
	"broker_id" uuid NOT NULL,
	"kind" "media_kind" NOT NULL,
	"role" "media_role" NOT NULL,
	"variant" text,
	"parent_media_id" uuid,
	"storage_path" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer,
	"height" integer,
	"duration_s" numeric(10, 3),
	"bytes" bigint NOT NULL,
	"checksum" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_cover" boolean DEFAULT false NOT NULL,
	"ai_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"external_account_id" text NOT NULL,
	"display_name" text NOT NULL,
	"credentials_encrypted" text,
	"token_expires_at" timestamp with time zone,
	"status" "platform_account_status" NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_accounts_broker_id_platform_external_account_id_unique" UNIQUE("broker_id","platform","external_account_id")
);
--> statement-breakpoint
CREATE TABLE "publication_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publication_id" uuid NOT NULL,
	"type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"actor" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"platform_account_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"content_id" uuid NOT NULL,
	"media_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" "publication_status" NOT NULL,
	"scheduled_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"external_id" text,
	"external_url" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" jsonb,
	"dry_run" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brokers" ADD CONSTRAINT "brokers_logo_media_id_media_id_fk" FOREIGN KEY ("logo_media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_definitions" ADD CONSTRAINT "field_definitions_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_parent_media_id_media_id_fk" FOREIGN KEY ("parent_media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_accounts" ADD CONSTRAINT "platform_accounts_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_events" ADD CONSTRAINT "publication_events_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_platform_account_id_platform_accounts_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."platform_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "publications_one_active_per_account" ON "publications" USING btree ("listing_id","platform_account_id") WHERE "status" NOT IN ('unpublished', 'cancelled');