CREATE TYPE "public"."broker_kind" AS ENUM('broker', 'brand');--> statement-breakpoint
ALTER TYPE "public"."platform" ADD VALUE 'x';--> statement-breakpoint
ALTER TYPE "public"."platform" ADD VALUE 'linkedin';--> statement-breakpoint
ALTER TYPE "public"."platform" ADD VALUE 'discord';--> statement-breakpoint
ALTER TYPE "public"."platform" ADD VALUE 'tiktok';--> statement-breakpoint
ALTER TYPE "public"."publication_status" ADD VALUE 'outcome_unknown';--> statement-breakpoint
ALTER TABLE "brokers" ADD COLUMN "kind" "broker_kind" DEFAULT 'broker' NOT NULL;