CREATE TYPE "public"."import_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
ALTER TABLE "import_runs" ALTER COLUMN "broker_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ALTER COLUMN "started_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "import_runs" ALTER COLUMN "started_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "status" "import_run_status" DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "dry_run" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "input" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "error" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "media_original_listing_checksum_unique" ON "media" USING btree ("listing_id","checksum") WHERE "role" = 'original';--> statement-breakpoint
ALTER TABLE "field_definitions" ADD CONSTRAINT "field_definitions_broker_category_key_unique" UNIQUE NULLS NOT DISTINCT("broker_id","category","key");--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_storage_path_unique" UNIQUE("storage_path");