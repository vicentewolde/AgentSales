import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVE_CONTENT_RUN_STATUSES,
  CLOSE_REASONS,
  CONTENT_RUN_STATUSES,
  CONTENT_STATUSES,
  CURRENCIES,
  FIELD_TYPES,
  IMPORT_RUN_STATUSES,
  LISTING_SOURCES,
  LISTING_STATUSES,
  MEDIA_KINDS,
  MEDIA_ROLES,
  OPERATIONS,
  PLATFORM_ACCOUNT_STATUSES,
  PLATFORMS,
  PUBLICATION_FORMATS,
  PUBLICATION_STATUSES,
  TERMINAL_PUBLICATION_STATUSES,
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
};

const EXPECTED_TABLES = [
  "brokers",
  "content_runs",
  "contents",
  "field_definitions",
  "import_runs",
  "listings",
  "media",
  "platform_accounts",
  "publication_events",
  "publications",
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

// Solo lee `CREATE TYPE`; un tipo recreado (0006: `publication_status`) queda con su última versión.
// Cuando una migración use `ALTER TYPE … ADD VALUE`, hay que sumarlo aquí.
function sqlEnums(sql: string): Record<string, string[]> {
  const enums: Record<string, string[]> = {};
  for (const match of sql.matchAll(/CREATE TYPE "public"\."(\w+)" AS ENUM\(([^)]*)\)/g)) {
    const [, name, values] = match;
    if (name && values !== undefined) {
      enums[name] = [...values.matchAll(/'([^']*)'/g)].map((value) => value[1] ?? "");
    }
  }
  return enums;
}

describe("migraciones", () => {
  const sql = migrationsSql();

  it("crean los tipos enum con los mismos valores que core (regenera si falla)", () => {
    expect(sqlEnums(sql)).toEqual(EXPECTED_ENUMS);
  });

  it("crean las 10 tablas del modelo de datos", () => {
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

  it("tienen los únicos de derivados de F2: una variante por original y un render por aviso (0005)", () => {
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "media_processed_parent_variant_unique" ON "media" USING btree ("parent_media_id","variant") WHERE "role" = 'processed';`,
    );
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "media_rendered_listing_variant_unique" ON "media" USING btree ("listing_id","variant") WHERE "role" = 'rendered';`,
    );
  });
});
