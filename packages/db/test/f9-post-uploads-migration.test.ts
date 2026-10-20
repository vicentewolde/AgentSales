import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../src/migrations.js";

// Migración 0017 (F9-T17, ADR-0025 punto 2): `post_uploads.status` suma `uploaded` (un archivo de
// más de 100 MB sin sha256 que llegó a R2 y espera que el worker lo hashee). Solo `ALTER TYPE …
// ADD VALUE`: se aplica dentro de una transacción como la del migrador, sin usar el valor nuevo en
// ella, y no cambia las subidas que ya había.

const sqlFiles = () =>
  readdirSync(MIGRATIONS_FOLDER)
    .filter((file) => file.endsWith(".sql"))
    .sort();

async function applyFiles(client: PGlite, files: string[], transaction = false): Promise<void> {
  if (transaction) await client.exec("BEGIN");
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_FOLDER, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim() !== "") await client.exec(statement);
    }
  }
  if (transaction) await client.exec("COMMIT");
}

const enumValues = async (client: PGlite, type: string) =>
  (
    await client.query<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = $1 ORDER BY e.enumsortorder`,
      [type],
    )
  ).rows.map((row) => row.label);

describe("migración 0017 sobre una base con subidas de posts", () => {
  let client: PGlite;
  let before: unknown[];
  let postId: string;

  beforeAll(async () => {
    client = new PGlite();
    const files = sqlFiles();
    const index = files.findIndex((file) => file.startsWith("0017_"));
    expect(index).toBeGreaterThan(0);
    await applyFiles(client, files.slice(0, index));

    const brokerId = (
      await client.query<{ id: string }>(
        `INSERT INTO brokers (slug, name, brand_name, primary_color, secondary_color, kind)
         VALUES ('marca-0016', 'Persona Inventada', 'Marca Inventada', '#112233', '#445566', 'brand')
         RETURNING id`,
      )
    ).rows[0]?.id;
    postId =
      (
        await client.query<{ id: string }>(
          `INSERT INTO posts (broker_id, topic, kind) VALUES ($1, 'Bastidores', 'video') RETURNING id`,
          [brokerId],
        )
      ).rows[0]?.id ?? "";
    for (const [n, status] of [
      [1, "pending"],
      [2, "completed"],
      [3, "abandoned"],
    ] as const) {
      await client.query(
        `INSERT INTO post_uploads (post_id, object_path, expected_bytes, status, expires_at)
         VALUES ($1, $2, 10, $3, now() + interval '1 day')`,
        [postId, `posts/${postId}/original/${String(n).repeat(64)}.jpg`, status],
      );
    }
    before = (await client.query("SELECT * FROM post_uploads ORDER BY id")).rows;

    // Como el migrador al desplegar: la 0017 dentro de una transacción.
    await applyFiles(client, files.slice(index), true);
  });

  afterAll(async () => {
    await client.close();
  });

  it("suma `uploaded` al final del tipo, sin recrearlo", async () => {
    expect(await enumValues(client, "post_upload_status")).toEqual([
      "pending",
      "completed",
      "abandoned",
      "uploaded",
    ]);
    const sql = readFileSync(
      join(MIGRATIONS_FOLDER, sqlFiles().find((file) => file.startsWith("0017_")) ?? ""),
      "utf8",
    );
    expect(sql).toMatch(/ALTER TYPE "public"\."post_upload_status" ADD VALUE 'uploaded'/);
    expect(sql).not.toMatch(/DROP TYPE|CREATE TYPE|'uploaded'.*(UPDATE|INSERT)/s);
  });

  it("no cambia las subidas de antes, y una subida nueva puede quedar `uploaded`", async () => {
    expect((await client.query("SELECT * FROM post_uploads ORDER BY id")).rows).toEqual(before);
    const inserted = await client.query<{ status: string }>(
      `INSERT INTO post_uploads (post_id, object_path, expected_bytes, status, expires_at)
       VALUES ($1, $2, 200000000, 'uploaded', now()) RETURNING status`,
      [postId, `posts/${postId}/original/11111111-2222-4333-8444-555555555555.mp4`],
    );
    expect(inserted.rows[0]?.status).toBe("uploaded");
  });
});
