import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../src/migrations.js";

// Migración 0020 (F9.5-T22, ADR-0036): `brokers.live_enabled boolean NOT NULL DEFAULT false`. Aditiva:
// los corredores y marcas que ya había quedan apagados (nada pasa a publicar de verdad por migrar),
// y una marca nueva nace apagada. Volver a una versión sin la columna la ignora.

const sqlFiles = () =>
  readdirSync(MIGRATIONS_FOLDER)
    .filter((file) => file.endsWith(".sql"))
    .sort();

async function applyFiles(client: PGlite, files: string[]): Promise<void> {
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_FOLDER, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim() !== "") await client.exec(statement);
    }
  }
}

describe("migración 0020 sobre una base con corredores y marcas", () => {
  let client: PGlite;

  beforeAll(async () => {
    client = new PGlite();
    const files = sqlFiles();
    const index = files.findIndex((file) => file.startsWith("0020_"));
    expect(index).toBeGreaterThan(0);
    await applyFiles(client, files.slice(0, index));
    await client.query(
      `INSERT INTO brokers (slug, name, brand_name, primary_color, secondary_color, operator_owned, kind)
       VALUES ('propia-0020', 'Persona Inventada', 'Propia', '#112233', '#445566', true, 'brand'),
              ('ajena-0020', 'Persona Inventada', 'Ajena', '#112233', '#445566', false, 'broker')`,
    );
    await applyFiles(client, files.slice(index));
  });

  afterAll(async () => {
    await client.close();
  });

  it("agrega la columna: no nula, booleana y apagada por defecto", async () => {
    const column = (
      await client.query<{ data_type: string; is_nullable: string; column_default: string }>(
        `SELECT data_type, is_nullable, column_default FROM information_schema.columns
         WHERE table_name = 'brokers' AND column_name = 'live_enabled'`,
      )
    ).rows[0];
    expect(column).toEqual({ data_type: "boolean", is_nullable: "NO", column_default: "false" });
  });

  it("deja apagados a los corredores que ya existían, también a los propios", async () => {
    const rows = (
      await client.query<{ slug: string; live_enabled: boolean }>(
        `SELECT slug, live_enabled FROM brokers WHERE slug LIKE '%-0020' ORDER BY slug`,
      )
    ).rows;
    expect(rows).toEqual([
      { slug: "ajena-0020", live_enabled: false },
      { slug: "propia-0020", live_enabled: false },
    ]);
  });

  it("una marca nueva nace apagada", async () => {
    const row = (
      await client.query<{ live_enabled: boolean }>(
        `INSERT INTO brokers (slug, name, brand_name, primary_color, secondary_color)
         VALUES ('nueva-0020', 'Persona Inventada', 'Nueva', '#112233', '#445566')
         RETURNING live_enabled`,
      )
    ).rows[0];
    expect(row?.live_enabled).toBe(false);
  });
});
