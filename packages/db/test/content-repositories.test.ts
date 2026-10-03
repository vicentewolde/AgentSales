import {
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryListingRepository,
} from "@agentsales/core/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrokerRepository } from "../src/repositories/brokers.js";
import { createContentRunRepository } from "../src/repositories/content-runs.js";
import { createContentRepository } from "../src/repositories/contents.js";
import { createListingRepository } from "../src/repositories/listings.js";
import { contentRuns, contents } from "../src/schema.js";
import { contentRepositoriesContract, newContent } from "./content-repositories.contract.js";
import { brokerData, newListing } from "./import-repositories.contract.js";
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
    contentRuns: createContentRunRepository(db),
    contents: createContentRepository(db),
    missingId: MISSING_UUID,
  };
}

contentRepositoriesContract("en memoria", async () => {
  const { contentRuns: runs, contents: texts } = createInMemoryContentRepositories();
  return {
    brokers: createInMemoryBrokerRepository(),
    listings: createInMemoryListingRepository(),
    contentRuns: runs,
    contents: texts,
    missingId: MISSING_UUID,
  };
});

contentRepositoriesContract("Drizzle sobre PGlite", pgliteRepositories);

describe("repositorios de contenido · lo que el puerto no muestra (PGlite)", () => {
  let repos: Awaited<ReturnType<typeof pgliteRepositories>>;
  let listingId: string;
  beforeAll(async () => {
    repos = await pgliteRepositories();
    const brokerId = (await repos.brokers.create(brokerData("contenido-pg"))).id;
    listingId = (await repos.listings.create(newListing(brokerId, "P-PG"))).id;
  });

  it("una fila con un reporte corrupto es CONTENT_RUN_INVALID, no un ZodError", async () => {
    const run = await repos.contentRuns.create({ listingId, texts: true });
    await repos.db
      .update(contentRuns)
      .set({ report: { warnings: "no es un arreglo" } })
      .where(eq(contentRuns.id, run.id));
    await expect(repos.contentRuns.get(run.id)).rejects.toMatchObject({
      code: "CONTENT_RUN_INVALID",
      retriable: false,
    });
    await repos.db.delete(contentRuns).where(eq(contentRuns.id, run.id));
  });

  it("un texto no puede apuntar a una corrida inexistente (FK) ni repetir canal en una corrida", async () => {
    const insert = (contentRunId: string) =>
      repos.db
        .insert(contents)
        .values({ ...newContent("instagram"), listingId, contentRunId, rawOutput: {} })
        .then(() => "ok")
        .catch((error: unknown) => (error as { cause?: { code?: string } }).cause?.code);
    expect(await insert(MISSING_UUID)).toBe("23503");

    const run = await repos.contentRuns.create({ listingId, texts: true });
    expect(await insert(run.id)).toBe("ok");
    expect(await insert(run.id)).toBe("23505");
  });
});
