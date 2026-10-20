CREATE TYPE "public"."brief_origin" AS ENUM('operator', 'ai');--> statement-breakpoint
CREATE TYPE "public"."plan_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."post_kind" AS ENUM('text', 'image', 'carousel', 'video');--> statement-breakpoint
CREATE TYPE "public"."post_source" AS ENUM('manual', 'ai');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('idea', 'draft', 'ready', 'archived');--> statement-breakpoint
CREATE TYPE "public"."post_upload_status" AS ENUM('pending', 'completed', 'abandoned');--> statement-breakpoint
CREATE TABLE "editorial_profiles" (
	"broker_id" uuid PRIMARY KEY NOT NULL,
	"languages" text[] DEFAULT '{es}'::text[] NOT NULL,
	"audience" text,
	"pillars" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"facts" text[] DEFAULT '{}'::text[] NOT NULL,
	"avoid" text[] DEFAULT '{}'::text[] NOT NULL,
	"cadence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_hashtags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" "plan_run_status" DEFAULT 'queued' NOT NULL,
	"request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"report" jsonb,
	"error" jsonb,
	"llm_usage" jsonb,
	"prompt_version" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"object_path" text NOT NULL,
	"expected_bytes" bigint NOT NULL,
	"status" "post_upload_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_uploads_object_path_unique" UNIQUE("object_path")
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"brief" text,
	"brief_origin" "brief_origin" DEFAULT 'operator' NOT NULL,
	"kind" "post_kind" NOT NULL,
	"status" "post_status" DEFAULT 'draft' NOT NULL,
	"source" "post_source" DEFAULT 'manual' NOT NULL,
	"pillar" text,
	"planned_at" timestamp with time zone,
	"plan_run_id" uuid,
	"created_by" uuid,
	"rationale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contents" DROP CONSTRAINT "contents_run_platform_unique";--> statement-breakpoint
ALTER TABLE "content_runs" ALTER COLUMN "listing_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "contents" ALTER COLUMN "listing_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "publications" ALTER COLUMN "listing_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "content_runs" ADD COLUMN "post_id" uuid;--> statement-breakpoint
ALTER TABLE "contents" ADD COLUMN "post_id" uuid;--> statement-breakpoint
ALTER TABLE "contents" ADD COLUMN "language" text DEFAULT 'es' NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "post_id" uuid;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "post_id" uuid;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "language" text DEFAULT 'es' NOT NULL;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "cost_usd" numeric(10, 4);--> statement-breakpoint
ALTER TABLE "editorial_profiles" ADD CONSTRAINT "editorial_profiles_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_runs" ADD CONSTRAINT "plan_runs_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_uploads" ADD CONSTRAINT "post_uploads_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_plan_run_id_plan_runs_id_fk" FOREIGN KEY ("plan_run_id") REFERENCES "public"."plan_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_runs_broker_created_idx" ON "plan_runs" USING btree ("broker_id","created_at");--> statement-breakpoint
CREATE INDEX "post_uploads_post_idx" ON "post_uploads" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "post_uploads_status_expires_idx" ON "post_uploads" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "posts_broker_status_planned_idx" ON "posts" USING btree ("broker_id","status","planned_at");--> statement-breakpoint
ALTER TABLE "content_runs" ADD CONSTRAINT "content_runs_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_runs_one_active_per_post" ON "content_runs" USING btree ("post_id") WHERE "status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "content_runs_post_created_idx" ON "content_runs" USING btree ("post_id","created_at");--> statement-breakpoint
CREATE INDEX "contents_post_platform_created_idx" ON "contents" USING btree ("post_id","platform","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "media_original_post_checksum_unique" ON "media" USING btree ("post_id","checksum") WHERE "role" = 'original';--> statement-breakpoint
CREATE UNIQUE INDEX "publications_one_active_per_post_format" ON "publications" USING btree ("post_id","platform_account_id","format","language") WHERE "status" NOT IN ('unpublished', 'cancelled');--> statement-breakpoint
CREATE INDEX "publications_post_idx" ON "publications" USING btree ("post_id");--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_run_platform_language_unique" UNIQUE("content_run_id","platform","language");--> statement-breakpoint
ALTER TABLE "content_runs" ADD CONSTRAINT "content_runs_one_subject" CHECK (num_nonnulls("content_runs"."listing_id", "content_runs"."post_id") = 1);--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_one_subject" CHECK (num_nonnulls("contents"."listing_id", "contents"."post_id") = 1);--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_at_most_one_subject" CHECK (num_nonnulls("media"."listing_id", "media"."post_id") <= 1);--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_one_subject" CHECK (num_nonnulls("publications"."listing_id", "publications"."post_id") = 1);