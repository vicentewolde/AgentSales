CREATE TABLE "worker_heartbeats" (
	"process_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"beat_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "content_runs" ADD COLUMN "auto_publish_done_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "worker_heartbeats_beat_idx" ON "worker_heartbeats" USING btree ("beat_at");--> statement-breakpoint
-- Las corridas terminadas antes de esta migración no quedan como cortadas (F8-T12): su
-- `auto_publish` ya corrió o lo resolvió el operador.
UPDATE "content_runs" SET "auto_publish_done_at" = COALESCE("finished_at", now()) WHERE "status" = 'succeeded';
