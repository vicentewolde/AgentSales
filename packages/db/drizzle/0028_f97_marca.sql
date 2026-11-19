CREATE TABLE "brand_card_styles" (
	"broker_id" uuid PRIMARY KEY NOT NULL,
	"style" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_knowledge" (
	"broker_id" uuid PRIMARY KEY NOT NULL,
	"stance" text,
	"tone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_knowledge_examples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid NOT NULL,
	"text" text NOT NULL,
	"note" text,
	"favorite" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_knowledge_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"project" text,
	"date" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_knowledge_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"source_text" text NOT NULL,
	"warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"error" jsonb,
	"llm_usage" jsonb,
	"created_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_knowledge_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid NOT NULL,
	"project" text NOT NULL,
	"date" text NOT NULL,
	"text" text NOT NULL,
	"source" text DEFAULT 'operator' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_card_texts" (
	"post_id" uuid NOT NULL,
	"language" text NOT NULL,
	"position" integer NOT NULL,
	"role" text NOT NULL,
	"headline" text NOT NULL,
	"subtitle" text DEFAULT '' NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_card_texts_post_id_language_position_pk" PRIMARY KEY("post_id","language","position")
);
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "card_theme" integer;--> statement-breakpoint
ALTER TABLE "brand_card_styles" ADD CONSTRAINT "brand_card_styles_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_knowledge" ADD CONSTRAINT "brand_knowledge_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_knowledge_examples" ADD CONSTRAINT "brand_knowledge_examples_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_knowledge_proposals" ADD CONSTRAINT "brand_knowledge_proposals_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_knowledge_proposals" ADD CONSTRAINT "brand_knowledge_proposals_run_id_brand_knowledge_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."brand_knowledge_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_knowledge_runs" ADD CONSTRAINT "brand_knowledge_runs_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_knowledge_runs" ADD CONSTRAINT "brand_knowledge_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_knowledge_updates" ADD CONSTRAINT "brand_knowledge_updates_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_card_texts" ADD CONSTRAINT "post_card_texts_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_knowledge_examples_broker_idx" ON "brand_knowledge_examples" USING btree ("broker_id","sort_order");--> statement-breakpoint
CREATE INDEX "brand_knowledge_proposals_broker_status_idx" ON "brand_knowledge_proposals" USING btree ("broker_id","status");--> statement-breakpoint
CREATE INDEX "brand_knowledge_runs_broker_created_idx" ON "brand_knowledge_runs" USING btree ("broker_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_knowledge_runs_one_active_per_broker" ON "brand_knowledge_runs" USING btree ("broker_id") WHERE "status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "brand_knowledge_updates_broker_date_idx" ON "brand_knowledge_updates" USING btree ("broker_id","date");