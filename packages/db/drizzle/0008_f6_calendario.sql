-- F6-T01 (ADR-0018 y ADR-0020, spec F6 §4.12): el índice de las programadas que vencen (el disparo
-- de cada minuto) y la publicación que republica a otra (`relisted_from`, una sola por publicación sin
-- contar las descartadas). Solo agrega: las publicaciones existentes quedan con `relisted_from` en NULL.
ALTER TABLE "publications" ADD COLUMN "relisted_from" uuid;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_relisted_from_publications_id_fk" FOREIGN KEY ("relisted_from") REFERENCES "public"."publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publications_scheduled_due" ON "publications" USING btree ("scheduled_at") WHERE "status" = 'scheduled';--> statement-breakpoint
CREATE UNIQUE INDEX "publications_relisted_from_unique" ON "publications" USING btree ("relisted_from") WHERE "relisted_from" IS NOT NULL AND "status" <> 'cancelled';