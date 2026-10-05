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

/**
 * Un aviso con su corredor, una cuenta de Instagram y un texto: lo que una publicación referencia.
 * Cada llamada usa un corredor propio, así los tests no comparten filas.
 */
async function seed(db: SchemaDatabase, client: PGlite, slug: string) {
  const brokerId = (await createBrokerRepository(db).create(brokerData(slug))).id;
  const listingId = (await createListingRepository(db).create(newListing(brokerId, "P-0006"))).id;
  const account = await client.query<{ id: string }>(
    `INSERT INTO platform_accounts (broker_id, platform, external_account_id, display_name, status)
     VALUES ($1, 'instagram', $2, '@muestra', 'connected') RETURNING id`,
    [brokerId, `ig-${slug}`],
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
  let seeds = 0;

  beforeAll(async () => {
    database = await createTestDatabase();
    client = (database.db as unknown as { $client: PGlite }).$client;
  });
  afterAll(() => database.close());

  /** Datos nuevos por test: ninguno depende de lo que dejó otro. */
  const fresh = () => {
    seeds += 1;
    return seed(database.db, client, `pub-0006-${seeds}`);
  };

  const insert = (
    ids: Awaited<ReturnType<typeof seed>>,
    format: string,
    status: string,
    accountId = ids.accountId,
  ) =>
    client.query(
      `INSERT INTO publications (listing_id, platform_account_id, platform, format, content_id,
         status, dry_run)
       VALUES ($1, $2, 'instagram', $3, $4, $5, true)`,
      [ids.listingId, accountId, format, ids.contentId, status],
    );

  it("deja convivir el carrusel y el reel, pero no dos activas del mismo formato", async () => {
    const ids = await fresh();
    await insert(ids, "post", "approved");
    await insert(ids, "reel", "approved");

    await expect(insert(ids, "post", "publishing")).rejects.toThrow(
      /publications_one_active_per_format/,
    );
  });

  it("el mismo formato sí puede estar activo en otra cuenta o en otro aviso", async () => {
    const ids = await fresh();
    const other = await fresh();
    await insert(ids, "post", "approved");

    await expect(insert(ids, "post", "approved", other.accountId)).resolves.toBeDefined();
    await expect(insert(other, "post", "approved")).resolves.toBeDefined();
  });

  it("un formato terminal no cuenta: se puede volver a publicar", async () => {
    const ids = await fresh();
    await insert(ids, "post", "cancelled");
    await insert(ids, "post", "unpublished");

    await expect(insert(ids, "post", "approved")).resolves.toBeDefined();
  });

  it("ya no acepta draft ni pending_approval, ni un formato desconocido", async () => {
    const ids = await fresh();

    await expect(insert(ids, "post", "pending_approval")).rejects.toThrow(/publication_status/);
    await expect(insert(ids, "post", "draft")).rejects.toThrow(/publication_status/);
    await expect(insert(ids, "story", "approved")).rejects.toThrow(/publication_format/);
  });

  it("exige el formato y guarda el progreso como jsonb", async () => {
    const ids = await fresh();
    await expect(
      client.query(
        `INSERT INTO publications (listing_id, platform_account_id, platform, content_id, status,
           dry_run)
         VALUES ($1, $2, 'instagram', $3, 'approved', true)`,
        [ids.listingId, ids.accountId, ids.contentId],
      ),
    ).rejects.toThrow(/null value in column "format"/);

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
      const statuses = await client.query<{ label: string }>(
        `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'publication_status' ORDER BY e.enumsortorder`,
      );
      expect(statuses.rows.map((row) => row.label)).toContain("pending_approval");
      const format = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'publications' AND column_name = 'format'`,
      );
      expect(format.rows).toHaveLength(0);
    } finally {
      await client.close();
    }
  });
});
