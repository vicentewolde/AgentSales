import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLOSE_REASONS,
  CONTENT_STATUSES,
  CURRENCIES,
  FIELD_TYPES,
  LISTING_SOURCES,
  LISTING_STATUSES,
  MEDIA_KINDS,
  MEDIA_ROLES,
  OPERATIONS,
  PLATFORM_ACCOUNT_STATUSES,
  PLATFORMS,
  PUBLICATION_STATUSES,
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
};

const EXPECTED_TABLES = [
  "brokers",
  "contents",
  "field_definitions",
  "import_runs",
  "listings",
  "media",
  "platform_accounts",
  "publication_events",
  "publications",
];

/** SQL acumulado de todas las migraciones, en orden. */
function migrationsSql(): string {
  return readdirSync(MIGRATIONS_FOLDER)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(MIGRATIONS_FOLDER, file), "utf8"))
    .join("\n");
}

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

  it("crean las 9 tablas del modelo de datos", () => {
    const tables = [...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map((match) => match[1]).sort();

    expect(tables).toEqual(EXPECTED_TABLES);
  });

  it("limitan a una publicación activa por aviso y cuenta, excluyendo los terminales", () => {
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "publications_one_active_per_account" ON "publications" USING btree ("listing_id","platform_account_id") WHERE "status" NOT IN ('unpublished', 'cancelled');`,
    );
  });

  it("mantienen las llaves de la importación idempotente y del seed", () => {
    expect(sql).toContain(`UNIQUE("broker_id","external_ref")`);
    expect(sql).toContain(`UNIQUE("slug")`);
  });
});
