CREATE TABLE "meta_deletion_requests" (
	"code" text PRIMARY KEY NOT NULL,
	"meta_user_id_hash" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"completed_at" timestamp with time zone,
	"accounts_affected" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "meta_deletion_requests_status" CHECK ("meta_deletion_requests"."status" = 'completed')
);
