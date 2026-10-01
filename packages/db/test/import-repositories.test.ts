import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importListings, ingestMedia, isAppError, type ListingSheetInput } from "@agentsales/core";
import {
  createInMemoryBrokerRepository,
  createInMemoryImportRunRepository,
  createInMemoryListingRepository,
  createInMemoryMediaFileSource,
  createInMemoryMediaRepository,
  createInMemoryMediaStorage,
  memoryFile,
} from "@agentsales/core/testing";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../src/migrations.js";
import { createBrokerRepository } from "../src/repositories/brokers.js";
import { createFieldDefinitionRepository } from "../src/repositories/field-definitions.js";
import { createImportRunRepository } from "../src/repositories/import-runs.js";
import { createListingRepository } from "../src/repositories/listings.js";
import { createMediaRepository } from "../src/repositories/media.js";
import { brokers, importRuns, listings, media } from "../src/schema.js";
import { seed } from "../src/seed.js";
import {
  brokerData,
  importRepositoriesContract,
  newListing,
  newMedia,
} from "./import-repositories.contract.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";

const MISSING_UUID = "00000000-0000-0000-0000-000000000000";

const databases: TestDatabase[] = [];
afterAll(async () => {
  await Promise.all(databases.map((database) => database.close()));
});

async function pgliteRepositories() {
  const database = await createTestDatabase();
  databases.push(database);
  const { db } = database;
  return {
    db,
    brokers: createBrokerRepository(db),
    listings: createListingRepository(db),
    importRuns: createImportRunRepository(db),
    media: createMediaRepository(db),
    async setListingStatus(id: string, status: (typeof listings.$inferSelect)["status"]) {
      await db.update(listings).set({ status }).where(eq(listings.id, id));
    },
    async setBrokerAutoPublish(id: string, autoPublish: boolean) {
      await db.update(brokers).set({ autoPublish }).where(eq(brokers.id, id));
    },
    missingId: MISSING_UUID,
  };
}

importRepositoriesContract("en memoria", async () => {
  const listingRepo = createInMemoryListingRepository();
  const mediaRepo = createInMemoryMediaRepository();
  const brokerRepo = createInMemoryBrokerRepository([], { media: mediaRepo });
  return {
    brokers: brokerRepo,
    listings: listingRepo,
    importRuns: createInMemoryImportRunRepository(),
    media: mediaRepo,
    setListingStatus: async (id, status) => listingRepo.setStatus(id, status),
    setBrokerAutoPublish: async (id, autoPublish) => brokerRepo.setAutoPublish(id, autoPublish),
    missingId: MISSING_UUID,
  };
});

importRepositoriesContract("Drizzle sobre PGlite", pgliteRepositories);

describe("repositorios Drizzle · lo que el puerto no muestra (PGlite)", () => {
  let repos: Awaited<ReturnType<typeof pgliteRepositories>>;
  beforeAll(async () => {
    repos = await pgliteRepositories();
  });

  it("price_amount (numeric) guarda los decimales y el aviso, sus columnas y atributos", async () => {
    const brokerId = (await repos.brokers.create(brokerData("precio-decimal"))).id;
    const created = await repos.listings.create(
      newListing(brokerId, "P-DEC", { priceAmount: 5800.5, internalNotes: "nota" }),
    );
    const [row] = await repos.db.select().from(listings).where(eq(listings.id, created.id));
    expect(row).toMatchObject({
      priceAmount: "5800.50",
      priceCurrency: "UF",
      category: "real_estate",
      source: "xlsx",
      internalNotes: "nota",
      attributes: { dormitorios: 3, amenities: ["Piscina"] },
    });
  });

  it("update no pisa el logo del corredor (logo_media_id)", async () => {
    const broker = await repos.brokers.create(brokerData("con-logo"));
    const [logo] = await repos.db
      .insert(media)
      .values({
        brokerId: broker.id,
        kind: "image",
        role: "original",
        storagePath: `brokers/${broker.id}/brand/logo.png`,
        mime: "image/png",
        bytes: 10,
        checksum: "sha-logo",
      })
      .returning({ id: media.id });
    await repos.db.update(brokers).set({ logoMediaId: logo?.id }).where(eq(brokers.id, broker.id));
    const updated = await repos.brokers.update(
      broker.id,
      brokerData("con-logo", { tone: "Formal" }),
    );
    expect(updated).toMatchObject({ tone: "Formal", logoMediaId: logo?.id });
  });

  it("update fija updated_at en corredores, avisos y runs", async () => {
    const broker = await repos.brokers.create(brokerData("con-fecha"));
    const listing = await repos.listings.create(newListing(broker.id, "P-FECHA"));
    const run = await repos.importRuns.create({
      source: "xlsx",
      fileName: "propiedades.xlsx",
      dryRun: false,
      input: { xlsxPath: "/tmp/p.xlsx", mediaDir: null, broker: null },
    });
    const updatedAt = async () => ({
      broker: (await repos.db.select().from(brokers).where(eq(brokers.id, broker.id)))[0]
        ?.updatedAt,
      listing: (await repos.db.select().from(listings).where(eq(listings.id, listing.id)))[0]
        ?.updatedAt,
      run: (await repos.db.select().from(importRuns).where(eq(importRuns.id, run.id)))[0]
        ?.updatedAt,
    });
    const before = await updatedAt();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await repos.brokers.update(broker.id, brokerData("con-fecha", { tone: "Formal" }));
    const {
      brokerId: _b,
      category: _c,
      source: _s,
      ...data
    } = newListing(broker.id, "P-FECHA", {
      sourceHash: "hash-2",
    });
    await repos.listings.update(listing.id, data);
    await repos.importRuns.recordListingsResult(run.id, {
      brokerId: broker.id,
      counts: { rowsTotal: 0, rowsCreated: 0, rowsUpdated: 0, rowsSkipped: 0, rowsFailed: 0 },
      report: { headers: null, broker: null, rows: [] },
    });
    const after = await updatedAt();
    for (const key of ["broker", "listing", "run"] as const) {
      expect(after[key]?.getTime(), key).toBeGreaterThan(before[key]?.getTime() ?? 0);
    }
  });

  it("MediaRepository solo ve originales: un derivado (F2) no se lista, no se encuentra ni se ordena", async () => {
    const brokerId = (await repos.brokers.create(brokerData("con-derivados"))).id;
    const listingId = (await repos.listings.create(newListing(brokerId, "P-DER"))).id;
    const original = await repos.media.create(newMedia(brokerId, listingId, "orig"));
    const [derived] = await repos.db
      .insert(media)
      .values({
        ...newMedia(brokerId, listingId, "orig", { storagePath: "derivado/ig_4x5.jpg" }),
        role: "processed",
        parentMediaId: original.id,
      })
      .returning({ id: media.id });

    expect(await repos.media.listOriginals(listingId)).toEqual([original]);
    expect(await repos.media.findByStoragePath("derivado/ig_4x5.jpg")).toBeNull();
    const error = await repos.media
      .arrange(listingId, [{ id: derived?.id ?? "", sortOrder: 0, isCover: true }])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(isAppError(error) && error.code).toBe("MEDIA_NOT_FOUND");
  });

  it("un corredor con datos que no calzan → BROKER_ROW_INVALID, no un ZodError", async () => {
    await repos.brokers.create(brokerData("hashtags-rotos"));
    await repos.db.execute(
      sql`update brokers set fixed_hashtags = array['#uno', null] where slug = 'hashtags-rotos'`,
    );
    const error = await repos.brokers
      .findBySlug("hashtags-rotos")
      .catch((caught: unknown) => caught);
    expect(isAppError(error) && [error.code, error.retriable]).toEqual([
      "BROKER_ROW_INVALID",
      false,
    ]);
  });

  it("un run con input corrupto en la base → IMPORT_RUN_INVALID", async () => {
    const run = await repos.importRuns.create({
      source: "xlsx",
      fileName: "propiedades.xlsx",
      dryRun: false,
      input: { xlsxPath: "/tmp/p.xlsx", mediaDir: null, broker: null },
    });
    await repos.db
      .update(importRuns)
      .set({ input: { otra: "cosa" } })
      .where(eq(importRuns.id, run.id));
    const error = await repos.importRuns.get(run.id).catch((caught: unknown) => caught);
    expect(isAppError(error) && error.code).toBe("IMPORT_RUN_INVALID");
  });

  it("un run con report corrupto en la base → IMPORT_RUN_INVALID, no reintentable", async () => {
    const run = await repos.importRuns.create({
      source: "xlsx",
      fileName: "propiedades.xlsx",
      dryRun: false,
      input: { xlsxPath: "/tmp/p.xlsx", mediaDir: null, broker: null },
    });
    await repos.db
      .update(importRuns)
      .set({ report: { rows: "no" } })
      .where(eq(importRuns.id, run.id));
    const error = await repos.importRuns.get(run.id).catch((caught: unknown) => caught);
    expect(isAppError(error) && [error.code, error.retriable]).toEqual([
      "IMPORT_RUN_INVALID",
      false,
    ]);
  });
});

describe("importListings de punta a punta contra Drizzle (PGlite)", () => {
  let repos: Awaited<ReturnType<typeof pgliteRepositories>>;
  beforeAll(async () => {
    repos = await pgliteRepositories();
    await seed(repos.db);
  });

  const deps = () => ({
    brokers: repos.brokers,
    listings: repos.listings,
    importRuns: repos.importRuns,
    fieldDefinitions: createFieldDefinitionRepository(repos.db),
    sha256: async (text: string) => createHash("sha256").update(text, "utf8").digest("hex"),
  });

  /** Hoja con las columnas del seed (datos inventados). */
  const sheet = (price: number): ListingSheetInput => {
    const raw = (ref: string) => ({
      id_propiedad: ref,
      operacion: "Venta",
      tipo: "Departamento",
      region: "Metropolitana",
      comuna: "Ñuñoa",
      direccion: "Calle Inventada 123",
      mostrar_direccion_exacta: "No",
      precio: price,
      moneda: "UF",
      sup_util_m2: 72,
      dormitorios: 3,
      banos: 2,
      estacionamientos: 1,
      bodegas: 1,
      amoblado: "No",
      disponibilidad: "Inmediata",
      publicar_en: "Instagram",
      estado_carga: "Listo",
    });
    const rows = [raw("P001"), raw("P002")];
    return {
      headers: Object.keys(rows[0] ?? {}),
      rows: rows.map((row, index) => ({ rowNumber: index + 2, raw: row })),
      broker: { nombre_corredor: "Persona", nombre_marca: "Marca E2E", color_primario: "#112233" },
    };
  };

  const runImport = async (input: ListingSheetInput) => {
    const run = await repos.importRuns.create({
      source: "xlsx",
      fileName: "propiedades.xlsx",
      dryRun: false,
      input: { xlsxPath: "/tmp/p.xlsx", mediaDir: null, broker: null },
    });
    const result = await importListings(deps(), { runId: run.id, input });
    return { ...result, runId: run.id };
  };

  it("crea, reimporta sin cambios (skipped) y actualiza al cambiar el precio", async () => {
    const first = await runImport(sheet(5800));
    expect(first.rows.map((row) => row.outcome)).toEqual(["created", "created"]);
    // El run quedó guardado en Postgres con su corredor, contadores y reporte.
    const broker = await repos.brokers.findBySlug("marca-e2e");
    expect(await repos.importRuns.get(first.runId)).toMatchObject({
      brokerId: broker?.id,
      rowsTotal: 2,
      rowsCreated: 2,
      report: { rows: [{ outcome: "created" }, { outcome: "created" }] },
    });
    const again = await runImport(sheet(5800));
    expect(again.rows.map((row) => row.outcome)).toEqual(["skipped", "skipped"]);
    const changed = await runImport(sheet(6100));
    expect(changed.rows.map((row) => row.outcome)).toEqual(["updated", "updated"]);
    const stored = await repos.db.select().from(listings);
    expect(stored.map((row) => row.priceAmount)).toEqual(["6100.00", "6100.00"]);
    expect(stored.every((row) => row.status === "draft")).toBe(true);
  });
});

describe("importListings + ingestMedia de punta a punta contra Drizzle (PGlite)", () => {
  let repos: Awaited<ReturnType<typeof pgliteRepositories>>;
  beforeAll(async () => {
    repos = await pgliteRepositories();
    await seed(repos.db);
  });

  /** Hoja con las columnas del seed y un logo (datos inventados). */
  const raw = {
    id_propiedad: "M001",
    operacion: "Venta",
    tipo: "Departamento",
    region: "Metropolitana",
    comuna: "Ñuñoa",
    direccion: "Calle Inventada 123",
    mostrar_direccion_exacta: "No",
    precio: 5800,
    moneda: "UF",
    sup_util_m2: 72,
    dormitorios: 3,
    banos: 2,
    estacionamientos: 1,
    bodegas: 1,
    amoblado: "No",
    disponibilidad: "Inmediata",
    publicar_en: "Instagram",
    estado_carga: "Listo",
    foto_portada: "foto2.jpg",
  };
  const input: ListingSheetInput = {
    headers: Object.keys(raw),
    rows: [{ rowNumber: 2, raw }],
    broker: {
      nombre_corredor: "Persona",
      nombre_marca: "Marca Medios",
      color_primario: "#112233",
      logo: "logo.png",
    },
  };
  const source = createInMemoryMediaFileSource({
    M001: {
      files: [
        memoryFile("M001/foto1.jpg", "foto-uno"),
        memoryFile("M001/foto2.jpg", "foto-dos"),
        memoryFile("M001/recorrido.mp4", "video-uno"),
      ],
    },
    _marca: { files: [memoryFile("_marca/logo.png", "logo")] },
  });
  const storage = createInMemoryMediaStorage();

  const load = async () => {
    const fieldDefinitions = createFieldDefinitionRepository(repos.db);
    const sha256 = async (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
    const run = await repos.importRuns.create({
      source: "xlsx",
      fileName: "propiedades.xlsx",
      dryRun: false,
      input: { xlsxPath: "/tmp/p.xlsx", mediaDir: "/tmp/medios", broker: null },
    });
    const imported = await importListings(
      { ...repos, fieldDefinitions, sha256 },
      { runId: run.id, input },
    );
    return ingestMedia({ ...repos, storage }, { runId: run.id, imported, source });
  };

  it("sube, registra con los únicos reales, elige portada, pasa a ready y asigna el logo; reimportar no repite", async () => {
    const first = await load();
    expect(first.media).toEqual({
      filesUploaded: 3,
      filesExisting: 0,
      filesSkipped: 0,
      filesFailed: 0,
    });

    const [listing] = await repos.db
      .select()
      .from(listings)
      .where(eq(listings.externalRef, "M001"));
    expect(listing?.status).toBe("ready");
    const rows = await repos.db
      .select()
      .from(media)
      .where(eq(media.listingId, listing?.id ?? ""))
      .orderBy(media.sortOrder);
    expect(rows.map((row) => [row.checksum, row.sortOrder, row.isCover, row.role])).toEqual([
      ["sha256-foto-uno", 0, false, "original"],
      ["sha256-foto-dos", 1, true, "original"],
      ["sha256-video-uno", 2, false, "original"],
    ]);
    const broker = await repos.brokers.findBySlug("marca-medios");
    const logo = await repos.media.findByStoragePath(`brokers/${broker?.id}/brand/sha256-logo.png`);
    expect(broker?.logoMediaId).toBe(logo?.id);

    const uploads = storage.uploads.length;
    const again = await load();
    expect(again.media).toMatchObject({ filesUploaded: 0, filesExisting: 3 });
    expect(storage.uploads).toHaveLength(uploads);
    expect(await repos.db.select().from(media)).toHaveLength(4);
  });
});

describe("migración 0002 (PGlite)", () => {
  /** Aplica a mano un SQL de `packages/db/drizzle` (sin el journal de drizzle). */
  async function applyMigration(client: PGlite, file: string) {
    const sql = readFileSync(join(MIGRATIONS_FOLDER, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.exec(statement);
    }
  }

  it("pasa a NULL los report '{}' existentes, y un run nuevo nace con report NULL", async () => {
    const client = new PGlite();
    try {
      await applyMigration(client, "0000_init.sql");
      await applyMigration(client, "0001_f1_carga.sql");
      await client.exec(
        `insert into import_runs (source, file_name) values ('xlsx', 'antes.xlsx')`,
      );
      await client.exec(
        `insert into import_runs (source, file_name, report) values ('xlsx', 'con-reporte.xlsx', '{"headers":null,"broker":null,"rows":[]}')`,
      );
      await applyMigration(client, "0002_import_runs_report_null.sql");
      await client.exec(
        `insert into import_runs (source, file_name) values ('xlsx', 'despues.xlsx')`,
      );
      const result = await client.query<{ file_name: string; report: unknown }>(
        "select file_name, report from import_runs order by file_name",
      );
      // Solo los `'{}'` pasan a NULL: un reporte real sobrevive el UPDATE.
      expect(result.rows).toEqual([
        { file_name: "antes.xlsx", report: null },
        { file_name: "con-reporte.xlsx", report: { headers: null, broker: null, rows: [] } },
        { file_name: "despues.xlsx", report: null },
      ]);
    } finally {
      await client.close();
    }
  });
});
