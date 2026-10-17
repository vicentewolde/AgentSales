import { createSecretBox } from "@agentsales/config";
import {
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryImportRunRepository,
  createInMemoryListingRepository,
  createInMemoryPlatformAccountRepository,
} from "@agentsales/core/testing";
import { afterAll } from "vitest";
import { createBrokerRepository } from "../src/repositories/brokers.js";
import { createContentRunRepository } from "../src/repositories/content-runs.js";
import { createContentRepository } from "../src/repositories/contents.js";
import { createImportRunRepository } from "../src/repositories/import-runs.js";
import { createListingRepository } from "../src/repositories/listings.js";
import { createPlatformAccountRepository } from "../src/repositories/platform-accounts.js";
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
