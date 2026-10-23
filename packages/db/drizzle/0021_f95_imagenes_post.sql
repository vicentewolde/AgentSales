CREATE TYPE "public"."post_image_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."post_image_source" AS ENUM('card', 'stock', 'ai');--> statement-breakpoint
CREATE TABLE "post_image_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"broker_id" uuid NOT NULL,
	"source" "post_image_source" NOT NULL,
	"status" "post_image_run_status" DEFAULT 'queued' NOT NULL,
	"request" jsonb NOT NULL,
	"media_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"cost_usd" numeric(10, 4),
	"model" text,
	"error" jsonb,
	"created_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post_image_runs" ADD CONSTRAINT "post_image_runs_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_image_runs" ADD CONSTRAINT "post_image_runs_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_image_runs" ADD CONSTRAINT "post_image_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_image_runs_post_created_idx" ON "post_image_runs" USING btree ("post_id","created_at");--> statement-breakpoint
CREATE INDEX "post_image_runs_broker_created_idx" ON "post_image_runs" USING btree ("broker_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "post_image_runs_one_active_per_post" ON "post_image_runs" USING btree ("post_id") WHERE "status" IN ('queued', 'running');