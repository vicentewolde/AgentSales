import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../src/migrations.js";

// Migración 0015 (F9-T03, ADR-0029): `posts`, `plan_runs`, `post_uploads` y `editorial_profiles`;
// `post_id` en textos, corridas, publicaciones y medios, con `listing_id` nulo y un `CHECK` de un
// solo sujeto; `language` y `cost_usd`. Se aplica sobre una base con datos de avisos de F3 a F8,
// dentro de una transacción como la del migrador, y no cambia ninguna fila.

const sqlFiles = () =>
  readdirSync(MIGRATIONS_FOLDER)
    .filter((file) => file.endsWith(".sql"))
    .sort();

/** Las sentencias de un archivo de migración, tal cual. */
const statementsOf = (file: string) =>
  readFileSync(join(MIGRATIONS_FOLDER, file), "utf8")
    .split("--> statement-breakpoint")
    .filter((statement) => statement.trim() !== "");

/**
 * Aplica archivos de migración sentencia por sentencia (sin el migrador de drizzle). Con
 * `transaction`, todos dentro de un solo `BEGIN … COMMIT`, como el migrador aplica las pendientes al
 * desplegar: un valor recién agregado a un enum no se puede usar en la misma transacción.
 */
async function applyFiles(client: PGlite, files: string[], transaction = false): Promise<void> {
  if (transaction) await client.exec("BEGIN");
  for (const file of files) {
    for (const statement of statementsOf(file)) await client.exec(statement);
  }
  if (transaction) await client.exec("COMMIT");
}

const TABLES = [
  "brokers",
  "listings",
  "media",
  "platform_accounts",
  "content_runs",
  "contents",
  "publications",
  "publication_events",
] as const;

type Row = Record<string, unknown>;

const rowsOf = async (client: PGlite, table: string) =>
  (await client.query<Row>(`SELECT * FROM ${table} ORDER BY id`)).rows;

/** Las filas de antes y las de después, recortadas a las columnas que ya existían. */
const sameColumns = (before: Row[], after: Row[]) =>
  after.map((row, index) =>
    Object.fromEntries(Object.keys(before[index] ?? {}).map((key) => [key, row[key]])),
  );

const one = async (client: PGlite, sql: string, params: unknown[] = []) =>
  (await client.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";

/** Datos como los de producción tras F8: corredores, un aviso con medios y logo, cuentas, textos y publicaciones. */
async function loadListingData(client: PGlite, tag: string) {
  const broker = async (slug: string, own: boolean) =>
    one(
      client,
      `INSERT INTO brokers (slug, name, brand_name, primary_color, secondary_color, operator_owned)
       VALUES ($1, 'Persona Inventada', 'Marca Inventada', '#112233', '#445566', $2) RETURNING id`,
      [slug, own],
    );
  const brokerId = await broker(`propio-${tag}`, true);
  await broker(`cliente-${tag}`, false);
  const listingId = await one(
    client,
    `INSERT INTO listings (broker_id, external_ref, category, operation, price_amount,
       price_currency, source, source_hash, status)
     VALUES ($1, 'P-0015', 'real_estate', 'sale', 5800, 'UF', 'xlsx', 'hash', 'active') RETURNING id`,
    [brokerId],
  );
  const medium = (
    listing: string | null,
    role: string,
    variant: string | null,
    parent: string | null,
    name: string,
  ) =>
    one(
      client,
      `INSERT INTO media (listing_id, broker_id, kind, role, variant, parent_media_id, storage_path,
         mime, bytes, checksum, is_cover)
       VALUES ($1, $2, 'image', $3, $4, $5, $6, 'image/jpeg', 1000, $7, $8) RETURNING id`,
      [
        listing,
        brokerId,
        role,
        variant,
        parent,
        `${tag}/${name}.jpg`,
        `sha-${name}`,
        role === "original" && listing !== null,
      ],
    );
  const original = await medium(listingId, "original", null, null, "foto");
  await medium(listingId, "processed", "ig_4x5", original, "foto-4x5");
  await medium(listingId, "rendered", "cover", null, "portada");
  const logo = await medium(null, "original", null, null, "logo");
  await client.query(`UPDATE brokers SET logo_media_id = $1 WHERE id = $2`, [logo, brokerId]);
  const account = (platform: string) =>
    one(
      client,
      `INSERT INTO platform_accounts (broker_id, platform, external_account_id, display_name, status)
       VALUES ($1, $2, $3, '@muestra', 'connected') RETURNING id`,
      [brokerId, platform, `${platform}-${tag}`],
    );
  const igAccountId = await account("instagram");
  const portalAccountId = await account("portal_inmobiliario");
  const runId = await one(
    client,
    `INSERT INTO content_runs (listing_id, status, finished_at, auto_publish_done_at, llm_usage)
     VALUES ($1, 'succeeded', now(), now(), '{"costUsd": 0.01}'::jsonb) RETURNING id`,
    [listingId],
  );
  await client.query(`INSERT INTO content_runs (listing_id, status) VALUES ($1, 'queued')`, [
    listingId,
  ]);
  const content = (platform: string) =>
    one(
      client,
      `INSERT INTO contents (listing_id, content_run_id, platform, body, hashtags, llm_provider,
         llm_model, prompt_version, raw_output, status)
       VALUES ($1, $2, $3, 'Texto', '{#depto}', 'fake', 'fake', 'v1', 'null'::jsonb, 'approved')
       RETURNING id`,
      [listingId, runId, platform],
    );
  const igContentId = await content("instagram");
  const portalContentId = await content("portal_inmobiliario");
  const publication = (
    accountId: string,
    platform: string,
    format: string,
    contentId: string,
    status: string,
  ) =>
    one(
      client,
      `INSERT INTO publications (listing_id, platform_account_id, platform, format, content_id,
         media_ids, status, dry_run, listing_source_hash)
       VALUES ($1, $2, $3, $4, $5, ARRAY[$6]::uuid[], $7, true, 'hash') RETURNING id`,
      [listingId, accountId, platform, format, contentId, original, status],
    );
  await publication(igAccountId, "instagram", "post", igContentId, "cancelled");
  const published = await publication(igAccountId, "instagram", "post", igContentId, "published");
  await publication(igAccountId, "instagram", "reel", igContentId, "failed");
  const scheduled = await publication(
    portalAccountId,
    "portal_inmobiliario",
    "post",
    portalContentId,
    "scheduled",
  );
  for (const [id, to] of [
    [published, "published"],
    [scheduled, "scheduled"],
  ] as const) {
    await client.query(
      `INSERT INTO publication_events (publication_id, type, from_status, to_status, actor, payload)
       VALUES ($1, 'status_changed', 'approved', $2, 'cli', '{}'::jsonb)`,
      [id, to],
    );
  }
  return { brokerId, listingId, original, igAccountId, runId, igContentId };
}

describe("migración 0015 sobre una base con avisos de F3 a F8", () => {
  let client: PGlite;
  let ids: Awaited<ReturnType<typeof loadListingData>>;
  const before: Record<string, Row[]> = {};
  let postId: string;

  beforeAll(async () => {
    client = new PGlite();
    const files = sqlFiles();
    const index = files.findIndex((file) => file.startsWith("0015_"));
    expect(files[index - 1]).toMatch(/^0014_/);
    await applyFiles(client, files.slice(0, index));
    ids = await loadListingData(client, "0015");
    for (const table of TABLES) before[table] = await rowsOf(client, table);

    await applyFiles(client, [files[index] ?? ""], true);

    postId = await one(
      client,
      `INSERT INTO posts (broker_id, topic, kind) VALUES ($1, 'Lo que aprendo', 'image') RETURNING id`,
      [ids.brokerId],
    );
  });
  afterAll(() => client.close());

  it("no cambia ninguna fila: las columnas de antes quedan iguales", async () => {
    for (const table of TABLES) {
      const after = await rowsOf(client, table);
      expect([table, sameColumns(before[table] ?? [], after)]).toEqual([table, before[table]]);
    }
  });

  it("lo existente queda como aviso, en español y sin costo", async () => {
    for (const table of ["content_runs", "contents", "publications", "media"]) {
      const rows = await client.query<{ post_id: string | null }>(`SELECT post_id FROM ${table}`);
      expect(rows.rows.every((row) => row.post_id === null)).toBe(true);
    }
    for (const table of ["contents", "publications"]) {
      const rows = await client.query<{ language: string }>(
        `SELECT DISTINCT language FROM ${table}`,
      );
      expect([table, rows.rows]).toEqual([table, [{ language: "es" }]]);
    }
    const costs = await client.query(`SELECT 1 FROM publications WHERE cost_usd IS NOT NULL`);
    expect(costs.rows).toEqual([]);
  });

  it("un post nace en draft, manual y con brief del operador; con su plan, subidas y perfil", async () => {
    const [post] = (
      await client.query<Row>(
        `SELECT status, source, brief_origin, brief, pillar, planned_at FROM posts WHERE id = $1`,
        [postId],
      )
    ).rows;
    expect(post).toEqual({
      status: "draft",
      source: "manual",
      brief_origin: "operator",
      brief: null,
      pillar: null,
      planned_at: null,
    });
    const planRunId = await one(
      client,
      `INSERT INTO plan_runs (broker_id, period_start, period_end)
       VALUES ($1, now(), now() + interval '14 days') RETURNING id`,
      [ids.brokerId],
    );
    await expect(
      client.query(
        `INSERT INTO posts (broker_id, topic, kind, status, source, brief_origin, plan_run_id,
           planned_at, rationale)
         VALUES ($1, 'Idea', 'text', 'idea', 'ai', 'ai', $2, now(), 'Porque sí')`,
        [ids.brokerId, planRunId],
      ),
    ).resolves.toBeDefined();
    await client.query(
      `INSERT INTO post_uploads (post_id, object_path, expected_bytes, expires_at)
       VALUES ($1, $2, 1000, now() + interval '1 hour')`,
      [postId, `posts/${postId}/a.jpg`],
    );
    await expect(
      client.query(
        `INSERT INTO post_uploads (post_id, object_path, expected_bytes, expires_at)
         VALUES ($1, $2, 1000, now())`,
        [postId, `posts/${postId}/a.jpg`],
      ),
    ).rejects.toThrow(/post_uploads_object_path_unique/);
    await client.query(`INSERT INTO editorial_profiles (broker_id) VALUES ($1)`, [ids.brokerId]);
    const [profile] = (
      await client.query<Row>(
        `SELECT languages, facts FROM editorial_profiles WHERE broker_id = $1`,
        [ids.brokerId],
      )
    ).rows;
    expect(profile).toEqual({ languages: ["es"], facts: [] });
  });

  describe("el CHECK de un solo sujeto", () => {
    it("una corrida exige exactamente un aviso o un post", async () => {
      const insert = (listing: string | null, post: string | null) =>
        client.query(
          `INSERT INTO content_runs (listing_id, post_id, status) VALUES ($1, $2, 'failed')`,
          [listing, post],
        );
      await expect(insert(ids.listingId, postId)).rejects.toThrow(/content_runs_one_subject/);
      await expect(insert(null, null)).rejects.toThrow(/content_runs_one_subject/);
      await expect(insert(null, postId)).resolves.toBeDefined();
    });

    it("un texto exige exactamente un aviso o un post", async () => {
      const insert = (listing: string | null, post: string | null, platform: string) =>
        client.query(
          `INSERT INTO contents (listing_id, post_id, content_run_id, platform, body, llm_provider,
             llm_model, prompt_version, raw_output)
           VALUES ($1, $2, $3, $4, 'Texto', 'fake', 'fake', 'v1', 'null'::jsonb)`,
          [listing, post, ids.runId, platform],
        );
      await expect(insert(ids.listingId, postId, "fb_marketplace")).rejects.toThrow(
        /contents_one_subject/,
      );
      await expect(insert(null, null, "fb_marketplace")).rejects.toThrow(/contents_one_subject/);
    });

    it("una publicación exige exactamente un aviso o un post", async () => {
      const insert = (listing: string | null, post: string | null) =>
        client.query(
          `INSERT INTO publications (listing_id, post_id, platform_account_id, platform, format,
             content_id, status, dry_run)
           VALUES ($1, $2, $3, 'instagram', 'post', $4, 'cancelled', true)`,
          [listing, post, ids.igAccountId, ids.igContentId],
        );
      await expect(insert(ids.listingId, postId)).rejects.toThrow(/publications_one_subject/);
      await expect(insert(null, null)).rejects.toThrow(/publications_one_subject/);
    });

    it("un medio admite un aviso, un post o ninguno (el logo), pero no los dos", async () => {
      const insert = (listing: string | null, post: string | null, name: string) =>
        client.query(
          `INSERT INTO media (listing_id, post_id, broker_id, kind, role, storage_path, mime, bytes,
             checksum)
           VALUES ($1, $2, $3, 'image', 'original', $4, 'image/jpeg', 1, $4)`,
          [listing, post, ids.brokerId, `check/${name}`],
        );
      await expect(insert(ids.listingId, postId, "ambos")).rejects.toThrow(
        /media_at_most_one_subject/,
      );
      await expect(insert(null, null, "otro-logo")).resolves.toBeDefined();
      await expect(insert(null, postId, "del-post")).resolves.toBeDefined();
    });
  });

  describe("los únicos del post", () => {
    it("una sola corrida activa por post", async () => {
      const otherPost = await one(
        client,
        `INSERT INTO posts (broker_id, topic, kind) VALUES ($1, 'Otro', 'text') RETURNING id`,
        [ids.brokerId],
      );
      const insert = (status: string) =>
        client.query(`INSERT INTO content_runs (post_id, status) VALUES ($1, $2)`, [
          otherPost,
          status,
        ]);
      await insert("succeeded");
      await insert("queued");
      await expect(insert("running")).rejects.toThrow(/content_runs_one_active_per_post/);
    });

    it("un texto por corrida, canal e idioma: el inglés convive con el español", async () => {
      const runId = await one(
        client,
        `INSERT INTO content_runs (post_id, status) VALUES ($1, 'succeeded') RETURNING id`,
        [postId],
      );
      const insert = (language: string) =>
        client.query(
          `INSERT INTO contents (post_id, content_run_id, platform, language, body, llm_provider,
             llm_model, prompt_version, raw_output)
           VALUES ($1, $2, 'instagram', $3, 'Texto', 'fake', 'fake', 'v2', 'null'::jsonb)`,
          [postId, runId, language],
        );
      await insert("es");
      await insert("en");
      await expect(insert("en")).rejects.toThrow(/contents_run_platform_language_unique/);
    });

    it("los textos de un aviso siguen siendo uno por corrida y canal", async () => {
      await expect(
        client.query(
          `INSERT INTO contents (listing_id, content_run_id, platform, body, llm_provider, llm_model,
             prompt_version, raw_output)
           VALUES ($1, $2, 'instagram', 'Otro', 'fake', 'fake', 'v1', 'null'::jsonb)`,
          [ids.listingId, ids.runId],
        ),
      ).rejects.toThrow(/contents_run_platform_language_unique/);
    });

    it("una publicación activa por post, cuenta, formato e idioma", async () => {
      const insert = (language: string, status: string) =>
        client.query(
          `INSERT INTO publications (post_id, platform_account_id, platform, format, language,
             content_id, status, dry_run)
           VALUES ($1, $2, 'instagram', 'post', $3, $4, $5, true)`,
          [postId, ids.igAccountId, language, ids.igContentId, status],
        );
      await insert("es", "cancelled");
      await insert("es", "approved");
      await insert("en", "scheduled");
      await expect(insert("es", "failed")).rejects.toThrow(
        /publications_one_active_per_post_format/,
      );
      // La del aviso en la misma cuenta y formato no choca con la del post.
      const listingActive = await client.query(
        `SELECT 1 FROM publications WHERE listing_id = $1 AND platform_account_id = $2
           AND format = 'post' AND status = 'published'`,
        [ids.listingId, ids.igAccountId],
      );
      expect(listingActive.rows).toHaveLength(1);
    });

    it("el mismo archivo no se sube dos veces a un post", async () => {
      const insert = (name: string) =>
        client.query(
          `INSERT INTO media (post_id, broker_id, kind, role, storage_path, mime, bytes, checksum)
           VALUES ($1, $2, 'image', 'original', $3, 'image/jpeg', 1, 'sha-repetido')`,
          [postId, ids.brokerId, `posts/${postId}/${name}.jpg`],
        );
      await insert("uno");
      await expect(insert("dos")).rejects.toThrow(/media_original_post_checksum_unique/);
    });
  });
});

describe("un despliegue nuevo aplica la 0014 y la 0015 en la misma transacción", () => {
  it("se aplican juntas sobre datos de F8 sin usar los valores nuevos de los enums", async () => {
    const client = new PGlite();
    try {
      const files = sqlFiles();
      const index = files.findIndex((file) => file.startsWith("0014_"));
      await applyFiles(client, files.slice(0, index));
      await loadListingData(client, "0014-0015");
      const pending = files.slice(index, index + 2);
      expect(pending.map((file) => file.slice(0, 4))).toEqual(["0014", "0015"]);

      await applyFiles(client, pending, true);

      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name IN ('posts', 'plan_runs')
         ORDER BY table_name`,
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual(["plan_runs", "posts"]);
    } finally {
      await client.close();
    }
  });
});
