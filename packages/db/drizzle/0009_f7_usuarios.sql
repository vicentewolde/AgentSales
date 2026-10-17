CREATE TYPE "public"."invitation_purpose" AS ENUM('invite', 'reset');--> statement-breakpoint
CREATE TYPE "public"."session_client" AS ENUM('panel', 'cli');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'broker');--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" "invitation_purpose" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "oauth_states_used" (
	"nonce_hash" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"client" "session_client" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"broker_id" uuid,
	"password_hash" text,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_role_broker" CHECK (("users"."role" = 'admin') = ("users"."broker_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "brokers" ADD COLUMN "operator_owned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Los corredores que ya existen son todos del operador (spec F7, D12).
UPDATE "brokers" SET "operator_owned" = true;--> statement-breakpoint
ALTER TABLE "brokers" ADD COLUMN "llm_monthly_cap_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "content_runs" ADD COLUMN "llm_usage" jsonb;--> statement-breakpoint
ALTER TABLE "publication_events" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitations_user_idx" ON "invitations" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_one_open_per_user" ON "invitations" USING btree ("user_id") WHERE "used_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_broker_idx" ON "users" USING btree ("broker_id");--> statement-breakpoint
ALTER TABLE "publication_events" ADD CONSTRAINT "publication_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;