-- F4-T01 (ADR-0015, spec F4 §4.10): catálogo de las plataformas (datos públicos con 7 días de vida),
-- lo último que informó la plataforma de cada publicación y la versión del aviso al nacer. Solo agrega:
-- las publicaciones existentes quedan con `remote_state` y `listing_source_hash` en NULL.
CREATE TABLE "platform_catalog" (
	"platform" "platform" NOT NULL,
	"key" text NOT NULL,
	"data" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_catalog_platform_key_pk" PRIMARY KEY("platform","key")
);
--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "remote_state" jsonb;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "listing_source_hash" text;