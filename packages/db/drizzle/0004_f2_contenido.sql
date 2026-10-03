CREATE TYPE "public"."content_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "content_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"status" "content_run_status" DEFAULT 'queued' NOT NULL,
	"texts" boolean DEFAULT true NOT NULL,
	"stage" text,
	"report" jsonb,
	"error" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contents" ADD COLUMN "content_run_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "content_runs" ADD CONSTRAINT "content_runs_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_runs_one_active_per_listing" ON "content_runs" USING btree ("listing_id") WHERE "status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "content_runs_listing_created_idx" ON "content_runs" USING btree ("listing_id","created_at");--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_content_run_id_content_runs_id_fk" FOREIGN KEY ("content_run_id") REFERENCES "public"."content_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contents_listing_platform_created_idx" ON "contents" USING btree ("listing_id","platform","created_at");--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_run_platform_unique" UNIQUE("content_run_id","platform");