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
import { contentRuns, contents, posts } from "../src/schema.js";
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

  it("una fila con un reporte corrupto es CONTENT_RUN_ROW_INVALID, no un ZodError", async () => {
    const run = await repos.contentRuns.create({ listingId, texts: true });
    await repos.db
      .update(contentRuns)
      .set({ report: { warnings: "no es un arreglo" } })
      .where(eq(contentRuns.id, run.id));
    await expect(repos.contentRuns.get(run.id)).rejects.toMatchObject({
      code: "CONTENT_RUN_ROW_INVALID",
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

  it("markSucceeded es todo o nada: si falla la escritura de un texto, la corrida sigue en running", async () => {
    const brokerId = (await repos.brokers.create(brokerData("contenido-rollback"))).id;
    const ownListing = (await repos.listings.create(newListing(brokerId, "P-ROLLBACK"))).id;
    const run = await repos.contentRuns.create({ listingId: ownListing, texts: true });
    await repos.contentRuns.markRunning(run.id);
    const before = await repos.contentRuns.get(run.id);
    // Un cuerpo nulo choca con NOT NULL en el segundo insert, después del UPDATE de la corrida.
    const broken = newContent("portal_inmobiliario", { body: null as unknown as string });
    await expect(
      repos.contentRuns.markSucceeded(run.id, {
        report: { warnings: [] },
        contents: [newContent("instagram"), broken],
      }),
    ).rejects.toMatchObject({ code: "DB_QUERY_FAILED" });
    expect(await repos.contentRuns.get(run.id)).toEqual(before);
    expect(await repos.contents.listCurrent(ownListing)).toEqual([]);
  });

  it("una fila de un post (F9, sin aviso) en un camino de avisos es una fila inválida y no escribe nada", async () => {
    // Hasta T04 los repositorios solo saben de avisos (ADR-0029, punto 14).
    const brokerId = (await repos.brokers.create(brokerData("contenido-post"))).id;
    const [post] = await repos.db
      .insert(posts)
      .values({ brokerId, topic: "Un post", kind: "text" })
      .returning();
    const [run] = await repos.db
      .insert(contentRuns)
      .values({ postId: post?.id, status: "running" })
      .returning();
    const runId = run?.id ?? "";
    await expect(repos.contentRuns.get(runId)).rejects.toMatchObject({
      code: "CONTENT_RUN_ROW_INVALID",
    });
    await expect(
      repos.contentRuns.markSucceeded(runId, {
        report: { warnings: [] },
        contents: [newContent("instagram")],
      }),
    ).rejects.toMatchObject({ code: "CONTENT_RUN_ROW_INVALID", retriable: false });
    const [after] = await repos.db.select().from(contentRuns).where(eq(contentRuns.id, runId));
    expect(after?.status).toBe("running");
    expect(await repos.db.select().from(contents).where(eq(contents.contentRunId, runId))).toEqual(
      [],
    );

    const [text] = await repos.db
      .insert(contents)
      .values({ ...newContent("instagram"), postId: post?.id, contentRunId: runId, rawOutput: {} })
      .returning();
    await expect(repos.contents.get(text?.id ?? "")).rejects.toMatchObject({
      code: "CONTENT_ROW_INVALID",
    });
  });
});
