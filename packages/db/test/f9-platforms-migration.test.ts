import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SchemaDatabase } from "../src/client.js";
import { MIGRATIONS_FOLDER } from "../src/migrations.js";
import { createListingRepository } from "../src/repositories/listings.js";
import * as schema from "../src/schema.js";
import { newListing } from "./import-repositories.contract.js";

// Migración 0014 (F9-T01, ADR-0029): las plataformas `x`, `linkedin`, `discord` y `tiktok`, el
// estado `outcome_unknown` (solo `ALTER TYPE … ADD VALUE`, nunca recrear el tipo como la 0006) y
// `brokers.kind`. Se aplica sobre una base con datos de F3 a F8 y no cambia ninguna fila.

const sqlFiles = () =>
  readdirSync(MIGRATIONS_FOLDER)
    .filter((file) => file.endsWith(".sql"))
    .sort();

/** Aplica un archivo de migración tal cual, sentencia por sentencia (sin el migrador de drizzle). */
async function applyFile(client: PGlite, file: string): Promise<void> {
  const sql = readFileSync(join(MIGRATIONS_FOLDER, file), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim() !== "") await client.exec(statement);
  }
}

/** Las filas de una tabla en orden estable, para comparar antes y después. */
async function rowsOf(client: PGlite, table: string): Promise<unknown[]> {
  const result = await client.query(`SELECT * FROM ${table} ORDER BY id`);
  return result.rows;
}

const enumValues = async (client: PGlite, type: string) =>
  (
    await client.query<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = $1 ORDER BY e.enumsortorder`,
      [type],
    )
  ).rows.map((row) => row.label);

describe("migración 0014 sobre una base con avisos y publicaciones", () => {
  let client: PGlite;
  let ids: { brokers: string[]; listingId: string; igAccountId: string; contentId: string };
  const before: Record<string, unknown[]> = {};
  const TABLES = [
    "listings",
    "platform_accounts",
    "content_runs",
    "contents",
    "publications",
    "publication_events",
  ];

  beforeAll(async () => {
    client = new PGlite();
    const files = sqlFiles();
    const index = files.findIndex((file) => file.startsWith("0014_"));
    expect(index).toBeGreaterThan(0);
    for (const file of files.slice(0, index)) await applyFile(client, file);

    // Datos como los de producción tras F8: dos corredores (uno propio), un aviso, sus cuentas, un
    // texto y publicaciones en estados activos y terminales, con su bitácora.
    const broker = async (slug: string, own: boolean) =>
      (
        await client.query<{ id: string }>(
          `INSERT INTO brokers (slug, name, brand_name, primary_color, secondary_color,
             operator_owned, auto_publish)
           VALUES ($1, 'Persona Inventada', 'Marca Inventada', '#112233', '#445566', $2, $2)
           RETURNING id`,
          [slug, own],
        )
      ).rows[0]?.id ?? "";
    const brokers = [await broker("propio-0014", true), await broker("cliente-0014", false)];
    const db = drizzle(client, { schema }) as unknown as SchemaDatabase;
    const listingId = (
      await createListingRepository(db).create(newListing(brokers[0] ?? "", "P-0014"))
    ).id;
    const account = async (platform: string) =>
      (
        await client.query<{ id: string }>(
          `INSERT INTO platform_accounts (broker_id, platform, external_account_id, display_name,
             status)
           VALUES ($1, $2, $3, '@muestra', 'connected') RETURNING id`,
          [brokers[0], platform, `${platform}-0014`],
        )
      ).rows[0]?.id ?? "";
    const igAccountId = await account("instagram");
    const portalAccountId = await account("portal_inmobiliario");
    const run = await client.query<{ id: string }>(
      `INSERT INTO content_runs (listing_id, status) VALUES ($1, 'succeeded') RETURNING id`,
      [listingId],
    );
    const content = await client.query<{ id: string }>(
      `INSERT INTO contents (listing_id, content_run_id, platform, body, llm_provider, llm_model,
         prompt_version, raw_output, status)
       VALUES ($1, $2, 'instagram', 'Texto', 'fake', 'fake', 'v1', 'null'::jsonb, 'approved')
       RETURNING id`,
      [listingId, run.rows[0]?.id],
    );
    const contentId = content.rows[0]?.id ?? "";
    const publication = async (
      accountId: string,
      platform: string,
      format: string,
      status: string,
    ) =>
      (
        await client.query<{ id: string }>(
          `INSERT INTO publications (listing_id, platform_account_id, platform, format, content_id,
             status, dry_run)
           VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`,
          [listingId, accountId, platform, format, contentId, status],
        )
      ).rows[0]?.id ?? "";
    await publication(igAccountId, "instagram", "post", "cancelled");
    await publication(igAccountId, "instagram", "post", "published");
    const pending = await publication(portalAccountId, "portal_inmobiliario", "post", "scheduled");
    await client.query(
      `INSERT INTO publication_events (publication_id, type, from_status, to_status, actor, payload)
       VALUES ($1, 'status_changed', 'approved', 'scheduled', 'cli', '{}'::jsonb)`,
      [pending],
    );

    for (const table of TABLES) before[table] = await rowsOf(client, table);
    await applyFile(client, files[index] ?? "");
    ids = { brokers, listingId, igAccountId, contentId };
  });
  afterAll(() => client.close());

  it("los corredores existentes quedan broker, sin cambiar lo demás", async () => {
    const rows = await client.query<{ slug: string; kind: string; operator_owned: boolean }>(
      `SELECT slug, kind, operator_owned FROM brokers ORDER BY slug`,
    );
    expect(rows.rows).toEqual([
      { slug: "cliente-0014", kind: "broker", operator_owned: false },
      { slug: "propio-0014", kind: "broker", operator_owned: true },
    ]);
  });

  it("no cambia ninguna fila de avisos, cuentas, textos, publicaciones ni bitácora", async () => {
    for (const table of TABLES) {
      expect([table, await rowsOf(client, table)]).toEqual([table, before[table]]);
    }
  });

  it("los tipos suman los valores al final, sin recrearse", async () => {
    expect(await enumValues(client, "platform")).toEqual([
      "instagram",
      "portal_inmobiliario",
      "fb_marketplace",
      "x",
      "linkedin",
      "discord",
      "tiktok",
    ]);
    expect((await enumValues(client, "publication_status")).at(-1)).toBe("outcome_unknown");
    expect(await enumValues(client, "broker_kind")).toEqual(["broker", "brand"]);
  });

  it("acepta cuentas de las redes nuevas y una marca; rechaza un kind desconocido", async () => {
    for (const platform of ["x", "linkedin", "discord", "tiktok"]) {
      await expect(
        client.query(
          `INSERT INTO platform_accounts (broker_id, platform, external_account_id, display_name,
             status)
           VALUES ($1, $2, $3, 'muestra', 'connected')`,
          [ids.brokers[1], platform, `${platform}-nueva`],
        ),
      ).resolves.toBeDefined();
    }
    await expect(
      client.query(
        `INSERT INTO brokers (slug, name, brand_name, primary_color, secondary_color, kind)
         VALUES ('vinny', 'Vinny', 'Vinny', '#112233', '#112233', 'brand')`,
      ),
    ).resolves.toBeDefined();
    await expect(
      client.query(
        `INSERT INTO brokers (slug, name, brand_name, primary_color, secondary_color, kind)
         VALUES ('oficina', 'O', 'O', '#112233', '#112233', 'office')`,
      ),
    ).rejects.toThrow(/broker_kind/);
  });

  it("una publicación outcome_unknown cuenta como activa para el único parcial", async () => {
    const insert = (status: string) =>
      client.query<{ id: string }>(
        `INSERT INTO publications (listing_id, platform_account_id, platform, format, content_id,
           status, dry_run)
         VALUES ($1, $2, 'instagram', 'reel', $3, $4, true) RETURNING id`,
        [ids.listingId, ids.igAccountId, ids.contentId, status],
      );
    const doubtful = (await insert("publishing")).rows[0]?.id;
    await client.query(`UPDATE publications SET status = 'outcome_unknown' WHERE id = $1`, [
      doubtful,
    ]);

    await expect(insert("approved")).rejects.toThrow(/publications_one_active_per_format/);
  });
});
