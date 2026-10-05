-- F3-T01 (ADR-0014). Ajustada a mano (spec F3 §4.7): drizzle-kit borraba el índice parcial después
-- de recrear el tipo, y Postgres no puede reconstruir un índice que compara `status` (text) con
-- valores del tipo viejo. Falla a propósito si `publications` tiene filas: está vacía desde F0
-- (ADR-0012), y sus estados `draft` y `pending_approval` dejan de existir.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "publications") THEN
    RAISE EXCEPTION '0006: publications tiene filas; esta migración supone la tabla vacía (ADR-0014)';
  END IF;
END
$$;--> statement-breakpoint
DROP INDEX "publications_one_active_per_account";--> statement-breakpoint
ALTER TABLE "publications" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."publication_status";--> statement-breakpoint
CREATE TYPE "public"."publication_status" AS ENUM('approved', 'scheduled', 'publishing', 'awaiting_manual_confirm', 'published', 'failed', 'paused', 'unpublished', 'cancelled');--> statement-breakpoint
ALTER TABLE "publications" ALTER COLUMN "status" SET DATA TYPE "public"."publication_status" USING "status"::"public"."publication_status";--> statement-breakpoint
CREATE TYPE "public"."publication_format" AS ENUM('post', 'reel');--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "format" "publication_format" NOT NULL;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "progress" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "publications_one_active_per_format" ON "publications" USING btree ("listing_id","platform_account_id","format") WHERE "status" NOT IN ('unpublished', 'cancelled');--> statement-breakpoint
CREATE INDEX "publications_listing_idx" ON "publications" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "publication_events_publication_created_idx" ON "publication_events" USING btree ("publication_id","created_at");
