import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SchemaDatabase } from "../src/client.js";
import { MIGRATIONS_FOLDER } from "../src/migrations.js";
import { createBrokerRepository } from "../src/repositories/brokers.js";
import { createListingRepository } from "../src/repositories/listings.js";
import * as schema from "../src/schema.js";
import { brokerData, newListing } from "./import-repositories.contract.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";

// Migración 0006 (F3-T01, ADR-0014): estados sin `draft` ni `pending_approval`, `format` y un
// único parcial por aviso, cuenta y formato. Ajustada a mano (spec F3 §4.7).

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

/** Un aviso con su corredor, una cuenta de Instagram y un texto: lo que una publicación referencia. */
async function seed(db: SchemaDatabase, client: PGlite, slug: string) {
  const brokerId = (await createBrokerRepository(db).create(brokerData(slug))).id;
  const listingId = (await createListingRepository(db).create(newListing(brokerId, "P-0006"))).id;
  const account = await client.query<{ id: string }>(
    `INSERT INTO platform_accounts (broker_id, platform, external_account_id, display_name, status)
     VALUES ($1, 'instagram', 'ig-1', '@muestra', 'connected') RETURNING id`,
    [brokerId],
  );
  const run = await client.query<{ id: string }>(
    `INSERT INTO content_runs (listing_id, status) VALUES ($1, 'succeeded') RETURNING id`,
    [listingId],
  );
  const content = await client.query<{ id: string }>(
    `INSERT INTO contents (listing_id, content_run_id, platform, body, llm_provider, llm_model,
       prompt_version, raw_output)
     VALUES ($1, $2, 'instagram', 'Texto', 'fake', 'fake', 'v1', 'null'::jsonb) RETURNING id`,
    [listingId, run.rows[0]?.id],
  );
  return {
    listingId,
    accountId: account.rows[0]?.id ?? "",
    contentId: content.rows[0]?.id ?? "",
  };
}

describe("migración 0006: publicaciones por formato", () => {
  let database: TestDatabase;
  let client: PGlite;
  let ids: Awaited<ReturnType<typeof seed>>;

  beforeAll(async () => {
    database = await createTestDatabase();
    client = (database.db as unknown as { $client: PGlite }).$client;
    ids = await seed(database.db, client, "pub-0006");
  });
  afterAll(() => database.close());

  const insert = (format: string, status: string) =>
    client.query(
      `INSERT INTO publications (listing_id, platform_account_id, platform, format, content_id,
         status, dry_run)
       VALUES ($1, $2, 'instagram', $3, $4, $5, true)`,
      [ids.listingId, ids.accountId, format, ids.contentId, status],
    );

  it("deja convivir el carrusel y el reel, pero no dos activas del mismo formato", async () => {
    await insert("post", "approved");
    await insert("reel", "approved");

    await expect(insert("post", "publishing")).rejects.toThrow(
      /publications_one_active_per_format/,
    );
  });

  it("un formato terminal no cuenta: se puede volver a publicar", async () => {
    await client.query(`UPDATE publications SET status = 'cancelled' WHERE format = 'post'`);

    await expect(insert("post", "approved")).resolves.toBeDefined();
  });

  it("ya no acepta draft ni pending_approval, ni un formato desconocido", async () => {
    await client.query(`DELETE FROM publications`);

    await expect(insert("post", "pending_approval")).rejects.toThrow(/publication_status/);
    await expect(insert("post", "draft")).rejects.toThrow(/publication_status/);
    await expect(insert("story", "approved")).rejects.toThrow(/publication_format/);
  });

  it("exige el formato y guarda el progreso como jsonb", async () => {
    await expect(
      client.query(
        `INSERT INTO publications (listing_id, platform_account_id, platform, content_id, status,
           dry_run)
         VALUES ($1, $2, 'instagram', $3, 'approved', true)`,
        [ids.listingId, ids.accountId, ids.contentId],
      ),
    ).rejects.toThrow(/format/);

    const row = await client.query<{ progress: unknown }>(
      `INSERT INTO publications (listing_id, platform_account_id, platform, format, content_id,
         status, dry_run, progress)
       VALUES ($1, $2, 'instagram', 'reel', $3, 'approved', true, '{"containerId":"c1"}')
       RETURNING progress`,
      [ids.listingId, ids.accountId, ids.contentId],
    );
    expect(row.rows[0]?.progress).toEqual({ containerId: "c1" });
  });
});

describe("migración 0006 sobre una tabla con filas", () => {
  it("falla a propósito y no cambia nada", async () => {
    const client = new PGlite();
    try {
      const files = sqlFiles();
      const index = files.findIndex((file) => file.startsWith("0006_"));
      expect(index).toBeGreaterThan(0);
      for (const file of files.slice(0, index)) await applyFile(client, file);

      const db = drizzle(client, { schema }) as unknown as SchemaDatabase;
      const ids = await seed(db, client, "pub-0006-filas");
      await client.query(
        `INSERT INTO publications (listing_id, platform_account_id, platform, content_id, status,
           dry_run)
         VALUES ($1, $2, 'instagram', $3, 'pending_approval', true)`,
        [ids.listingId, ids.accountId, ids.contentId],
      );

      await expect(applyFile(client, files[index] ?? "")).rejects.toThrow(
        /publications tiene filas/,
      );
      const indexes = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'publications'`,
      );
      expect(indexes.rows.map((row) => row.indexname)).toContain(
        "publications_one_active_per_account",
      );
    } finally {
      await client.close();
    }
  });
});
