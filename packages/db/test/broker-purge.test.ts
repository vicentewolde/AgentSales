import { randomUUID } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SchemaDatabase } from "../src/client.js";
import { createBrokerPurgeRepository } from "../src/repositories/broker-purge.js";
import {
  brokers,
  contentRuns,
  contents,
  editorialProfiles,
  fieldDefinitions,
  importRuns,
  invitations,
  listings,
  loginChallenges,
  media,
  planRuns,
  platformAccounts,
  postImageRuns,
  posts,
  postUploads,
  publicationEvents,
  publications,
  sessions,
  userRecoveryCodes,
  users,
} from "../src/schema.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";

// F9.5-T14 (ADR-0035): borrar un corredor de verdad, contra Postgres (PGlite) con todas las
// migraciones. Un corredor con de todo queda sin una sola fila, y lo demás queda idéntico: se
// compara **cada tabla de la base**, fila por fila, con la foto de antes de crearlo.

let database: TestDatabase;
let db: SchemaDatabase;
const later = new Date("2026-11-01T12:00:00.000Z");

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
});
afterAll(async () => {
  await database.close();
});

/** Las filas de una consulta cruda (PGlite las entrega en `rows`). */
async function rowsOf<T>(query: SQL): Promise<T[]> {
  return ((await db.execute(query)) as unknown as { rows: T[] }).rows;
}

/** Todas las tablas del esquema `public`, con sus filas ordenadas: la foto de la base. */
async function snapshot(): Promise<Record<string, unknown[]>> {
  const tables = await rowsOf<{ table_name: string }>(
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const result: Record<string, unknown[]> = {};
  for (const { table_name: name } of tables) {
    const rows = await rowsOf<Record<string, unknown>>(sql.raw(`SELECT * FROM "${name}"`));
    result[name] = rows
      .map((row) => JSON.stringify(row))
      .sort()
      .map((row) => JSON.parse(row) as unknown);
  }
  return result;
}

/** Cuántas filas tiene cada tabla. */
const countsOf = (snap: Record<string, unknown[]>) =>
  Object.fromEntries(Object.entries(snap).map(([name, rows]) => [name, rows.length]));

/**
 * Un corredor con de todo: logo, usuario con sesión, invitación, códigos y desafío; cuenta con
 * credenciales; campo propio; propiedad con medios (original, variante, render), corrida, texto y
 * publicaciones (una republicada) con su bitácora; plan, post con medio, texto, publicación y
 * subida; perfil editorial y una carga.
 */
async function seedBroker(
  slug: string,
  options: { adminId?: string; status?: "published" | "scheduled" } = {},
) {
  const [broker] = await db
    .insert(brokers)
    .values({
      slug,
      name: `Persona ${slug}`,
      brandName: `Marca ${slug}`,
      primaryColor: "#112233",
      secondaryColor: "#112233",
    })
    .returning();
  if (broker === undefined) throw new Error("sin corredor");
  const b = broker.id;
  const [logo] = await db
    .insert(media)
    .values({
      brokerId: b,
      kind: "image",
      role: "original",
      storagePath: `brokers/${b}/brand/logo.png`,
      mime: "image/png",
      bytes: 10,
      checksum: `logo-${slug}`,
    })
    .returning();
  await db
    .update(brokers)
    .set({ logoMediaId: logo?.id ?? null })
    .where(sql`id = ${b}`);

  const [user] = await db
    .insert(users)
    .values({
      email: `${slug}@ejemplo.cl`,
      name: "Corredora",
      role: "broker",
      brokerId: b,
      passwordHash: "scrypt$hash",
      totpSecretEncrypted: "cifrado-totp",
      totpEnabledAt: later,
    })
    .returning();
  const u = user?.id ?? "";
  await db.insert(sessions).values({
    tokenHash: `sesion-${slug}`,
    userId: u,
    client: "panel",
    expiresAt: later,
    lastSeenAt: later,
  });
  await db.insert(invitations).values({
    userId: u,
    tokenHash: `invitacion-${slug}`,
    purpose: "invite",
    expiresAt: later,
    usedAt: later,
    ...(options.adminId === undefined ? {} : { createdBy: options.adminId }),
  });
  await db.insert(userRecoveryCodes).values({ userId: u, codeHash: `codigo-${slug}` });
  await db
    .insert(loginChallenges)
    .values({ tokenHash: `desafio-${slug}`, userId: u, expiresAt: later });

  const [account] = await db
    .insert(platformAccounts)
    .values({
      brokerId: b,
      platform: "instagram",
      externalAccountId: `ig-${slug}`,
      displayName: `@${slug}`,
      credentialsEncrypted: "cifrado-token",
      status: "connected",
    })
    .returning();
  const accountId = account?.id ?? "";
  await db.insert(fieldDefinitions).values({
    brokerId: b,
    category: "inmueble",
    key: `propio_${slug.replace(/-/g, "_")}`,
    label: "Propio",
    type: "text",
    sourceColumn: "Propio",
  });

  const [listing] = await db
    .insert(listings)
    .values({
      brokerId: b,
      externalRef: "P-1",
      category: "inmueble",
      priceAmount: "5800",
      priceCurrency: "UF",
      source: "xlsx",
      sourceHash: "hash",
      attributes: { dormitorios: 3 },
    })
    .returning();
  const l = listing?.id ?? "";
  const [original] = await db
    .insert(media)
    .values({
      listingId: l,
      brokerId: b,
      kind: "image",
      role: "original",
      storagePath: `brokers/${b}/listings/${l}/original/a.jpg`,
      mime: "image/jpeg",
      bytes: 100,
      checksum: "a",
    })
    .returning();
  await db.insert(media).values([
    {
      listingId: l,
      brokerId: b,
      kind: "image",
      role: "processed",
      variant: "ig_4x5",
      parentMediaId: original?.id ?? null,
      storagePath: `brokers/${b}/listings/${l}/processed/ig_4x5/a-v1.jpg`,
      mime: "image/jpeg",
      bytes: 80,
      checksum: "a-ig",
    },
    {
      listingId: l,
      brokerId: b,
      kind: "image",
      role: "rendered",
      variant: "cover",
      storagePath: `brokers/${b}/listings/${l}/rendered/cover/x.jpg`,
      mime: "image/jpeg",
      bytes: 80,
      checksum: "cover",
    },
  ]);
  const [listingRun] = await db
    .insert(contentRuns)
    .values({ listingId: l, status: "succeeded" })
    .returning();
  const [listingContent] = await db
    .insert(contents)
    .values({
      listingId: l,
      contentRunId: listingRun?.id ?? "",
      platform: "instagram",
      body: "Texto",
      status: "approved",
      llmProvider: "fake",
      llmModel: "fake",
      promptVersion: "1",
      rawOutput: {},
    })
    .returning();
  const [first] = await db
    .insert(publications)
    .values({
      listingId: l,
      platformAccountId: accountId,
      platform: "instagram",
      format: "post",
      contentId: listingContent?.id ?? "",
      mediaIds: [original?.id ?? ""],
      status: "unpublished",
      dryRun: true,
    })
    .returning();
  const [second] = await db
    .insert(publications)
    .values({
      listingId: l,
      platformAccountId: accountId,
      platform: "instagram",
      format: "post",
      contentId: listingContent?.id ?? "",
      status: options.status ?? "published",
      dryRun: true,
      relistedFrom: first?.id ?? null,
      scheduledAt: options.status === "scheduled" ? later : null,
    })
    .returning();
  await db.insert(publicationEvents).values([
    { publicationId: first?.id ?? "", type: "created", actor: "operator", userId: u },
    { publicationId: second?.id ?? "", type: "publish_attempt", actor: "system" },
  ]);

  const [plan] = await db
    .insert(planRuns)
    .values({ brokerId: b, periodStart: later, periodEnd: later, status: "succeeded" })
    .returning();
  const [post] = await db
    .insert(posts)
    .values({
      brokerId: b,
      topic: "Tema",
      kind: "image",
      planRunId: plan?.id ?? null,
      createdBy: u,
    })
    .returning();
  const p = post?.id ?? "";
  await db.insert(media).values({
    postId: p,
    brokerId: b,
    kind: "image",
    role: "original",
    storagePath: `posts/${p}/original/b.jpg`,
    mime: "image/jpeg",
    bytes: 50,
    checksum: "b",
  });
  // F9.5-T25: un pedido de imágenes del post, con gasto de IA.
  await db.insert(postImageRuns).values({
    postId: p,
    brokerId: b,
    source: "ai",
    status: "succeeded",
    request: { source: "ai", prompt: "una casa", format: "4:5" },
    costUsd: 0.04,
    model: "modelo",
  });
  await db.insert(postUploads).values({
    postId: p,
    objectPath: `posts/${p}/original/pendiente.jpg`,
    expectedBytes: 10,
    expiresAt: later,
  });
  const [postRun] = await db
    .insert(contentRuns)
    .values({ postId: p, status: "succeeded" })
    .returning();
  const [postContent] = await db
    .insert(contents)
    .values({
      postId: p,
      contentRunId: postRun?.id ?? "",
      platform: "instagram",
      body: "Post",
      llmProvider: "fake",
      llmModel: "fake",
      promptVersion: "1",
      rawOutput: {},
    })
    .returning();
  const [postPublication] = await db
    .insert(publications)
    .values({
      postId: p,
      platformAccountId: accountId,
      platform: "instagram",
      format: "post",
      contentId: postContent?.id ?? "",
      status: "published",
      dryRun: true,
    })
    .returning();
  await db
    .insert(publicationEvents)
    .values({ publicationId: postPublication?.id ?? "", type: "created", actor: "operator" });
  await db.insert(editorialProfiles).values({ brokerId: b, audience: "Familias" });
  const [run] = await db
    .insert(importRuns)
    .values({ brokerId: b, status: "succeeded", source: "xlsx", fileName: "planilla.xlsx" })
    .returning();
  return {
    broker,
    userId: u,
    listingId: l,
    postId: p,
    importRunId: run?.id ?? "",
    scheduledId: second?.id ?? "",
  };
}

describe("BrokerPurgeRepository (PGlite)", () => {
  it("borra todo lo del corredor y deja cada tabla como estaba antes de crearlo", async () => {
    const repo = createBrokerPurgeRepository(db);
    const [admin] = await db
      .insert(users)
      .values({ email: "admin@ejemplo.cl", name: "Admin", role: "admin" })
      .returning();
    await seedBroker("otro", { adminId: admin?.id ?? "" });
    // Un campo global (`broker_id` null): es de todos y debe sobrevivir.
    await db.insert(fieldDefinitions).values({
      category: "inmueble",
      key: "global_de_prueba",
      label: "Global",
      type: "text",
      sourceColumn: "Global",
    });
    const before = await snapshot();
    expect(
      (before.field_definitions as { broker_id: string | null }[]).some(
        (row) => row.broker_id === null,
      ),
    ).toBe(true);

    const target = await seedBroker("prueba", { adminId: admin?.id ?? "" });
    const seeded = countsOf(await snapshot());
    // La siembra tocó cada tabla que cuelga de un corredor.
    for (const table of [
      "brokers",
      "users",
      "sessions",
      "invitations",
      "user_recovery_codes",
      "login_challenges",
      "platform_accounts",
      "field_definitions",
      "listings",
      "media",
      "content_runs",
      "contents",
      "publications",
      "publication_events",
      "plan_runs",
      "posts",
      "post_uploads",
      "post_image_runs",
      "editorial_profiles",
      "import_runs",
    ]) {
      expect(seeded[table], table).toBeGreaterThan(countsOf(before)[table] ?? 0);
    }

    const summary = await repo.summarize(target.broker.id);
    expect(summary).toEqual({
      counts: {
        listings: 1,
        media: 5,
        publications: 3,
        // La del aviso publicada y la del post: seguirán en las redes.
        livePublications: 2,
        posts: 1,
        users: 1,
        accounts: 1,
        importRuns: 1,
      },
      blocking: [],
    });
    const refs = await repo.storageRefs(target.broker.id);
    expect(refs.mediaKeys.sort()).toEqual(
      [
        `brokers/${target.broker.id}/brand/logo.png`,
        `brokers/${target.broker.id}/listings/${target.listingId}/original/a.jpg`,
        `brokers/${target.broker.id}/listings/${target.listingId}/processed/ig_4x5/a-v1.jpg`,
        `brokers/${target.broker.id}/listings/${target.listingId}/rendered/cover/x.jpg`,
        `posts/${target.postId}/original/b.jpg`,
      ].sort(),
    );
    expect(refs.uploadKeys).toEqual([`posts/${target.postId}/original/pendiente.jpg`]);
    expect(refs.postIds).toEqual([target.postId]);
    expect(refs.importRunIds).toEqual([target.importRunId]);

    const outcome = await repo.purge(target.broker.id);
    // Los posts y las cargas que borró de verdad (de ahí salen los prefijos de R2).
    expect(outcome.postIds).toEqual([target.postId]);
    expect(outcome.importRunIds).toEqual([target.importRunId]);
    expect(outcome.deleted).toEqual({
      publication_events: 3,
      publications: 3,
      contents: 2,
      content_runs: 2,
      media: 5,
      post_uploads: 1,
      post_image_runs: 1,
      posts: 1,
      plan_runs: 1,
      editorial_profiles: 1,
      listings: 1,
      platform_accounts: 1,
      field_definitions: 1,
      import_runs: 1,
      sessions: 1,
      invitations: 1,
      user_recovery_codes: 1,
      login_challenges: 1,
      users: 1,
      brokers: 1,
    });
    // Cada tabla, fila por fila, como antes: el otro corredor y el administrador intactos.
    expect(await snapshot()).toEqual(before);
    await expect(repo.purge(target.broker.id)).rejects.toMatchObject({
      code: "BROKER_NOT_FOUND",
    });
  });

  it("se niega con una publicación programada y no borra nada", async () => {
    const repo = createBrokerPurgeRepository(db);
    const target = await seedBroker(`programado-${randomUUID().slice(0, 8)}`, {
      status: "scheduled",
    });
    const before = await snapshot();
    const summary = await repo.summarize(target.broker.id);
    expect(summary.blocking).toEqual([
      { publicationId: target.scheduledId, status: "scheduled", platform: "instagram" },
    ]);
    await expect(repo.purge(target.broker.id)).rejects.toMatchObject({
      code: "BROKER_HAS_ACTIVE_PUBLICATIONS",
      details: { publicationIds: [target.scheduledId] },
    });
    expect(await snapshot()).toEqual(before);
  });

  it("un corredor sin nada se borra solo", async () => {
    const repo = createBrokerPurgeRepository(db);
    const [empty] = await db
      .insert(brokers)
      .values({
        slug: "vacio",
        name: "V",
        brandName: "V",
        primaryColor: "#000000",
        secondaryColor: "#000000",
      })
      .returning();
    const id = empty?.id ?? "";
    expect((await repo.summarize(id)).counts).toEqual({
      listings: 0,
      media: 0,
      publications: 0,
      livePublications: 0,
      posts: 0,
      users: 0,
      accounts: 0,
      importRuns: 0,
    });
    expect(await repo.storageRefs(id)).toEqual({
      mediaKeys: [],
      uploadKeys: [],
      postIds: [],
      importRunIds: [],
    });
    const { deleted, postIds, importRunIds } = await repo.purge(id);
    expect(deleted.brokers).toBe(1);
    expect(Object.entries(deleted).filter(([table, n]) => table !== "brokers" && n > 0)).toEqual(
      [],
    );
    expect({ postIds, importRunIds }).toEqual({ postIds: [], importRunIds: [] });
  });

  it("cubre cada tabla con FK hacia lo que borra (una tabla nueva sin cubrir hace fallar esto)", async () => {
    const repo = createBrokerPurgeRepository(db);
    const [empty] = await db
      .insert(brokers)
      .values({
        slug: "cobertura",
        name: "C",
        brandName: "C",
        primaryColor: "#000000",
        secondaryColor: "#000000",
      })
      .returning();
    // Las tablas que `purge` toca: las que informa (aunque sea con 0 filas).
    const covered = new Set(Object.keys((await repo.purge(empty?.id ?? "")).deleted));
    const references = await rowsOf<{ source: string; column: string; target: string }>(sql`
      SELECT kcu.table_name AS source, kcu.column_name AS "column", ref.table_name AS target
      FROM information_schema.referential_constraints rc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_schema = rc.constraint_schema AND kcu.constraint_name = rc.constraint_name
      JOIN information_schema.key_column_usage ref
        ON ref.constraint_schema = rc.unique_constraint_schema
        AND ref.constraint_name = rc.unique_constraint_name
        AND ref.ordinal_position = kcu.position_in_unique_constraint
      WHERE rc.constraint_schema = 'public'
      ORDER BY source, "column"`);
    const purgedTables = new Set([
      "brokers",
      "listings",
      "posts",
      "publications",
      "media",
      "users",
      "platform_accounts",
      "contents",
      "content_runs",
      "plan_runs",
    ]);
    const relevant = references.filter(({ target }) => purgedTables.has(target));
    // La consulta ve las FK de verdad (no una lista vacía que pase siempre).
    expect(relevant).toContainEqual({ source: "media", column: "listing_id", target: "listings" });
    expect(relevant).toContainEqual({ source: "sessions", column: "user_id", target: "users" });
    const uncovered = relevant.filter(({ source }) => !covered.has(source));
    expect(uncovered, "tablas con FK a lo que se borra que `purge` no cubre").toEqual([]);
  });
});
