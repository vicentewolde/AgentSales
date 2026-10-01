ALTER TABLE "import_runs" ALTER COLUMN "report" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "import_runs" ALTER COLUMN "report" DROP NOT NULL;--> statement-breakpoint
-- Agregado a mano (drizzle-kit no genera cambios de datos): un run sin resultado tiene `report` en NULL, no `{}`.
UPDATE "import_runs" SET "report" = NULL WHERE "report" = '{}'::jsonb;