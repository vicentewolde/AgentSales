import { createSecretBox } from "@agentsales/config";
import { chileMonthRange, type LlmCallUsage } from "@agentsales/core";
import {
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryImportRunRepository,
  createInMemoryListingRepository,
  createInMemoryPlatformAccountRepository,
} from "@agentsales/core/testing";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createBrokerRepository } from "../src/repositories/brokers.js";
import { createContentRunRepository } from "../src/repositories/content-runs.js";
import { createContentRepository } from "../src/repositories/contents.js";
import { createImportRunRepository } from "../src/repositories/import-runs.js";
import { createListingRepository } from "../src/repositories/listings.js";
import { createPlatformAccountRepository } from "../src/repositories/platform-accounts.js";
import { contentRuns } from "../src/schema.js";
import { brokerData, newListing } from "./import-repositories.contract.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";
import { scopeRepositoriesContract } from "./scope.contract.js";

const databases: TestDatabase[] = [];
afterAll(async () => {
  await Promise.all(databases.map((database) => database.close()));
});

scopeRepositoriesContract("en memoria", async () => {
  const brokers = createInMemoryBrokerRepository();
  const listings = createInMemoryListingRepository();
  const { contentRuns, contents } = createInMemoryContentRepositories({
    brokerOfListing: (id) => listings.all().find((listing) => listing.id === id)?.brokerId ?? null,
  });
  return {
    brokers,
    listings,
    importRuns: createInMemoryImportRunRepository(),
    accounts: createInMemoryPlatformAccountRepository({ brokers }),
    contentRuns,
    contents,
  };
});

scopeRepositoriesContract("Drizzle sobre PGlite", async () => {
  const database = await createTestDatabase();
  databases.push(database);
  const { db } = database;
  return {
    brokers: createBrokerRepository(db),
    listings: createListingRepository(db),
    importRuns: createImportRunRepository(db),
    accounts: createPlatformAccountRepository(db, { secretBox: createSecretBox("k".repeat(32)) }),
    contentRuns: createContentRunRepository(db),
    contents: createContentRepository(db),
  };
});

describe("gasto del mes · el borde del mes de Chile (PGlite)", () => {
  it("cuenta lo creado desde el inicio del mes y deja fuera el inicio del siguiente", async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const { db } = database;
    const brokers = createBrokerRepository(db);
    const listings = createListingRepository(db);
    const runs = createContentRunRepository(db);
    const brokerId = (await brokers.create(brokerData("borde-del-mes"))).id;
    const listingId = (await listings.create(newListing(brokerId, "P-BORDE"))).id;
    const call: LlmCallUsage = {
      provider: "anthropic-api",
      model: "claude-sonnet-5-5",
      inputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 1,
      costUsd: 1,
      priceTable: "2026-10-16",
      requestId: null,
    };
    const { from, to } = chileMonthRange("2026-10");
    const at = async (createdAt: Date) => {
      const run = await runs.create({ listingId, texts: true });
      await runs.addLlmUsage(run.id, call);
      await runs.markFailed(run.id, { code: "X", message: "x" });
      await db.update(contentRuns).set({ createdAt }).where(eq(contentRuns.id, run.id));
    };
    await at(from);
    await at(new Date(to.getTime() - 1));
    await at(to);
    await at(new Date(from.getTime() - 1));
    expect(await runs.sumLlmCost({ from, to, brokerId })).toEqual([
      { brokerId, costUsd: 2, runs: 2 },
    ]);
  });
});
