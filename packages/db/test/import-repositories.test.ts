import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importListings, isAppError, type ListingSheetInput } from "@agentsales/core";
import {
  createInMemoryBrokerRepository,
  createInMemoryImportRunRepository,
  createInMemoryListingRepository,
} from "@agentsales/core/testing";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../src/migrations.js";
import { createBrokerRepository } from "../src/repositories/brokers.js";
import { createFieldDefinitionRepository } from "../src/repositories/field-definitions.js";
import { createImportRunRepository } from "../src/repositories/import-runs.js";
import { createListingRepository } from "../src/repositories/listings.js";
import { importRuns, listings } from "../src/schema.js";
import { seed } from "../src/seed.js";
import {
  brokerData,
  importRepositoriesContract,
  newListing,
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
    async setListingStatus(id: string, status: (typeof listings.$inferSelect)["status"]) {
      await db.update(listings).set({ status }).where(eq(listings.id, id));
    },
    missingId: MISSING_UUID,
  };
}

importRepositoriesContract("en memoria", async () => {
  const listingRepo = createInMemoryListingRepository();
  return {
    brokers: createInMemoryBrokerRepository(),
    listings: listingRepo,
    importRuns: createInMemoryImportRunRepository(),
    setListingStatus: async (id, status) => listingRepo.setStatus(id, status),
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
    return importListings(deps(), { runId: run.id, input });
  };

  it("crea, reimporta sin cambios (skipped) y actualiza al cambiar el precio", async () => {
    const first = await runImport(sheet(5800));
    expect(first.rows.map((row) => row.outcome)).toEqual(["created", "created"]);
    const again = await runImport(sheet(5800));
    expect(again.rows.map((row) => row.outcome)).toEqual(["skipped", "skipped"]);
    const changed = await runImport(sheet(6100));
    expect(changed.rows.map((row) => row.outcome)).toEqual(["updated", "updated"]);
    const stored = await repos.db.select().from(listings);
    expect(stored.map((row) => row.priceAmount)).toEqual(["6100.00", "6100.00"]);
    expect(stored.every((row) => row.status === "draft")).toBe(true);
  });
});

describe("migración 0002 (PGlite)", () => {
  /** Aplica a mano los SQL de `packages/db/drizzle` hasta `upTo` (sin el journal de drizzle). */
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
      await applyMigration(client, "0002_import_runs_report_null.sql");
      await client.exec(
        `insert into import_runs (source, file_name) values ('xlsx', 'despues.xlsx')`,
      );
      const result = await client.query<{ file_name: string; report: unknown }>(
        "select file_name, report from import_runs order by file_name",
      );
      expect(result.rows).toEqual([
        { file_name: "antes.xlsx", report: null },
        { file_name: "despues.xlsx", report: null },
      ]);
    } finally {
      await client.close();
    }
  });
});
