CREATE TYPE "public"."registry_status" AS ENUM('draft', 'approved', 'withdrawn');--> statement-breakpoint
CREATE TABLE "registry_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"broker_id" uuid NOT NULL,
	"status" "registry_status" DEFAULT 'draft' NOT NULL,
	"payload" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registry_records_hash_len" CHECK (char_length("registry_records"."content_hash") = 64)
);
--> statement-breakpoint
ALTER TABLE "registry_records" ADD CONSTRAINT "registry_records_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_records" ADD CONSTRAINT "registry_records_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_records" ADD CONSTRAINT "registry_records_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "registry_records_listing_unique" ON "registry_records" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "registry_records_broker_idx" ON "registry_records" USING btree ("broker_id");