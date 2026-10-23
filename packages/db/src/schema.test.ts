import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVE_CONTENT_RUN_STATUSES,
  BRIEF_ORIGINS,
  BROKER_KINDS,
  CLOSE_REASONS,
  CONTENT_RUN_STATUSES,
  CONTENT_STATUSES,
  CURRENCIES,
  FIELD_TYPES,
  IMPORT_RUN_STATUSES,
  INVITATION_PURPOSES,
  LISTING_SOURCES,
  LISTING_STATUSES,
  MEDIA_KINDS,
  MEDIA_ROLES,
  OPERATIONS,
  PLAN_RUN_STATUSES,
  PLATFORM_ACCOUNT_STATUSES,
  PLATFORMS,
  POST_IMAGE_RUN_STATUSES,
  POST_IMAGE_SOURCES,
  POST_KINDS,
  POST_SOURCES,
  POST_STATUSES,
  POST_UPLOAD_STATUSES,
  PUBLICATION_FORMATS,
  PUBLICATION_STATUSES,
  SESSION_CLIENTS,
  TERMINAL_PUBLICATION_STATUSES,
  USER_ROLES,
} from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "./migrations.js";

// Tipos de Postgres y sus valores esperados (docs/02-modelo-datos.md), desde core.
const EXPECTED_ENUMS: Record<string, readonly string[]> = {
  platform: PLATFORMS,
  platform_account_status: PLATFORM_ACCOUNT_STATUSES,
  field_type: FIELD_TYPES,
  operation: OPERATIONS,
  listing_status: LISTING_STATUSES,
  close_reason: CLOSE_REASONS,
  currency: CURRENCIES,
  listing_source: LISTING_SOURCES,
  media_kind: MEDIA_KINDS,
  media_role: MEDIA_ROLES,
  content_status: CONTENT_STATUSES,
  publication_status: PUBLICATION_STATUSES,
  publication_format: PUBLICATION_FORMATS,
  import_run_status: IMPORT_RUN_STATUSES,
  content_run_status: CONTENT_RUN_STATUSES,
  user_role: USER_ROLES,
  session_client: SESSION_CLIENTS,
  invitation_purpose: INVITATION_PURPOSES,
  // F9-T01 (0014): corredor o marca.
  broker_kind: BROKER_KINDS,
  // F9-T03 (0015): los posts, sus planes y sus subidas.
  brief_origin: BRIEF_ORIGINS,
  plan_run_status: PLAN_RUN_STATUSES,
  post_kind: POST_KINDS,
  post_source: POST_SOURCES,
  post_status: POST_STATUSES,
  post_upload_status: POST_UPLOAD_STATUSES,
  // F9.5-T25 (0020): los pedidos de imágenes de un post.
  post_image_source: POST_IMAGE_SOURCES,
  post_image_run_status: POST_IMAGE_RUN_STATUSES,
};

const EXPECTED_TABLES = [
  "brokers",
  "content_runs",
  "contents",
  // F9-T03 (0015): el perfil editorial de una marca.
  "editorial_profiles",
  "field_definitions",
  "import_runs",
  "invitations",
  "listings",
  // F8-T15 (0012): el segundo paso de entrar.
  "login_challenges",
  "media",
  // F8-T17 (0013): los pedidos de borrado de Meta.
  "meta_deletion_requests",
  "oauth_states_used",
  // F9-T03 (0015): los planes de ideas, sus posts y las subidas pendientes.
  "plan_runs",
  "platform_accounts",
  "platform_catalog",
  // F9.5-T25 (0020): los pedidos de imágenes de un post (tarjetas, biblioteca e IA).
  "post_image_runs",
  "post_uploads",
  "posts",
  "publication_events",
  "publications",
  "sessions",
  // F8-T15 (0012): los códigos de recuperación del doble factor.
  "user_recovery_codes",
  "users",
  // F8-T12 (0011): el latido del worker.
  "worker_heartbeats",
];

/**
 * SQL acumulado de todas las migraciones, en orden. Estos tests comparan la migración con `core`
 * (enums, tablas, índices clave); el desfase de columnas lo detecta `pnpm db:generate` en CI.
 */
function migrationsSql(): string {
  return readdirSync(MIGRATIONS_FOLDER)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(MIGRATIONS_FOLDER, file), "utf8"))
    .join("\n");
}

// Lee `CREATE TYPE` y `ALTER TYPE … ADD VALUE` en el orden de las migraciones; un tipo recreado
// (0006: `publication_status`) queda con su última versión, y un valor agregado (0010:
// `awaiting_upload`) en su lugar (`BEFORE`/`AFTER`, o al final).
function sqlEnums(sql: string): Record<string, string[]> {
  const enums: Record<string, string[]> = {};
  const statements =
    /CREATE TYPE "public"\."(\w+)" AS ENUM\(([^)]*)\)|ALTER TYPE "public"\."(\w+)" ADD VALUE '([^']*)'(?: (BEFORE|AFTER) '([^']*)')?/g;
  for (const match of sql.matchAll(statements)) {
    const [, created, values, altered, added, position, anchor] = match;
    if (created && values !== undefined) {
      enums[created] = [...values.matchAll(/'([^']*)'/g)].map((value) => value[1] ?? "");
    } else if (altered && added !== undefined) {
      const list = enums[altered] ?? [];
      const at = anchor === undefined ? -1 : list.indexOf(anchor);
      if (at < 0) list.push(added);
      else list.splice(position === "AFTER" ? at + 1 : at, 0, added);
      enums[altered] = list;
    }
  }
  return enums;
}

describe("migraciones", () => {
  const sql = migrationsSql();

  it("crean los tipos enum con los mismos valores que core (regenera si falla)", () => {
    expect(sqlEnums(sql)).toEqual(EXPECTED_ENUMS);
  });

  it("crean las 18 tablas del modelo de datos", () => {
    const tables = [...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map((match) => match[1]).sort();

    expect(tables).toEqual(EXPECTED_TABLES);
  });

  it("limitan a una publicación activa por aviso, cuenta y formato, excluyendo los terminales (0006)", () => {
    const terminals = TERMINAL_PUBLICATION_STATUSES.map((status) => `'${status}'`).join(", ");

    expect(sql).toContain(
      `CREATE UNIQUE INDEX "publications_one_active_per_format" ON "publications" USING btree ("listing_id","platform_account_id","format") WHERE "status" NOT IN (${terminals});`,
    );
    expect(sql).toContain(`DROP INDEX "publications_one_active_per_account";`);
  });

  it("el catálogo tiene una entrada por plataforma y clave, y las publicaciones su estado remoto (0007)", () => {
    expect(sql).toContain(
      `CONSTRAINT "platform_catalog_platform_key_pk" PRIMARY KEY("platform","key")`,
    );
    expect(sql).toContain(`ALTER TABLE "publications" ADD COLUMN "remote_state" jsonb;`);
    expect(sql).toContain(`ALTER TABLE "publications" ADD COLUMN "listing_source_hash" text;`);
  });

  it("el latido del worker y el auto_publish cortado; las corridas terminadas no quedan como cortadas (0011)", () => {
    expect(sql).toContain(`CREATE TABLE "worker_heartbeats"`);
    expect(sql).toContain(
      `ALTER TABLE "content_runs" ADD COLUMN "auto_publish_done_at" timestamp with time zone;`,
    );
    expect(sql).toContain(
      `UPDATE "content_runs" SET "auto_publish_done_at" = COALESCE("finished_at", now()) WHERE "status" = 'succeeded';`,
    );
  });

  it("mantienen las llaves de la importación idempotente y del seed", () => {
    expect(sql).toContain(`UNIQUE("broker_id","external_ref")`);
    expect(sql).toContain(`UNIQUE("slug")`);
  });

  it("tienen los únicos de F1: definiciones por key, medios por checksum y por ruta (0001)", () => {
    expect(sql).toContain(`UNIQUE NULLS NOT DISTINCT("broker_id","category","key")`);
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "media_original_listing_checksum_unique" ON "media" USING btree ("listing_id","checksum") WHERE "role" = 'original';`,
    );
    expect(sql).toContain(`UNIQUE("storage_path")`);
  });

  it("tienen los únicos de contenido de F2: una corrida activa por aviso y un texto por canal (0004)", () => {
    const active = ACTIVE_CONTENT_RUN_STATUSES.map((status) => `'${status}'`).join(", ");
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "content_runs_one_active_per_listing" ON "content_runs" USING btree ("listing_id") WHERE "status" IN (${active});`,
    );
    expect(sql).toContain(
      `ALTER TABLE "contents" ADD CONSTRAINT "contents_run_platform_unique" UNIQUE("content_run_id","platform");`,
    );
  });

  it("un sujeto por texto, corrida y publicación, y a lo más uno por medio; los únicos del post (0015)", () => {
    const terminals = TERMINAL_PUBLICATION_STATUSES.map((status) => `'${status}'`).join(", ");
    for (const table of ["content_runs", "contents", "publications"]) {
      expect(sql).toContain(
        `CHECK (num_nonnulls("${table}"."listing_id", "${table}"."post_id") = 1)`,
      );
    }
    expect(sql).toContain(`CHECK (num_nonnulls("media"."listing_id", "media"."post_id") <= 1)`);
    expect(sql).toContain(`DROP CONSTRAINT "contents_run_platform_unique"`);
    expect(sql).toContain(
      `ALTER TABLE "contents" ADD CONSTRAINT "contents_run_platform_language_unique" UNIQUE("content_run_id","platform","language");`,
    );
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "publications_one_active_per_post_format" ON "publications" USING btree ("post_id","platform_account_id","format","language") WHERE "status" NOT IN (${terminals});`,
    );
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "media_original_post_checksum_unique" ON "media" USING btree ("post_id","checksum") WHERE "role" = 'original';`,
    );
  });

  it("la 0015 no usa valores de enum que agregó la 0014 (se aplican en la misma transacción)", () => {
    const file = readdirSync(MIGRATIONS_FOLDER).find((name) => name.startsWith("0015_"));
    const migration = readFileSync(join(MIGRATIONS_FOLDER, file ?? ""), "utf8");
    for (const value of ["outcome_unknown", "brand", "x", "linkedin", "discord", "tiktok"]) {
      expect([value, migration.includes(`'${value}'`)]).toEqual([value, false]);
    }
  });

  it("tienen los únicos de derivados de F2: una variante por original y un render por aviso (0005)", () => {
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "media_processed_parent_variant_unique" ON "media" USING btree ("parent_media_id","variant") WHERE "role" = 'processed';`,
    );
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "media_rendered_listing_variant_unique" ON "media" USING btree ("listing_id","variant") WHERE "role" = 'rendered';`,
    );
  });
});
