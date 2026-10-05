import { createSecretBox } from "@agentsales/config";
import type { ListingLock, LockedRepositories } from "@agentsales/core";
import {
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryListingLock,
  createInMemoryListingRepository,
  createInMemoryMediaRepository,
  createInMemoryPlatformAccountRepository,
  createInMemoryPublicationRepository,
} from "@agentsales/core/testing";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createListingLock } from "../src/listing-lock.js";
import { createBrokerRepository } from "../src/repositories/brokers.js";
import { createContentRunRepository } from "../src/repositories/content-runs.js";
import { createContentRepository } from "../src/repositories/contents.js";
import { createListingRepository } from "../src/repositories/listings.js";
import { createMediaRepository } from "../src/repositories/media.js";
import { createPlatformAccountRepository } from "../src/repositories/platform-accounts.js";
import { createPublicationRepository } from "../src/repositories/publications.js";
import { publications } from "../src/schema.js";
import { newContent } from "./content-repositories.contract.js";
import { brokerData, newListing } from "./import-repositories.contract.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";
import { connectedAccount } from "./platform-accounts.contract.js";
import { publicationRepositoryContract } from "./publications.contract.js";

const MISSING_UUID = "00000000-0000-0000-0000-000000000000";
const secretBox = createSecretBox("k".repeat(32));

const databases: TestDatabase[] = [];
afterAll(async () => {
  await Promise.all(databases.map((database) => database.close()));
});

let sequence = 0;
const unique = (prefix: string) => `${prefix}-${++sequence}`;

/** Un aviso con una cuenta conectada y un texto de Instagram (en una corrida terminada). */
async function seed(
  repos: Pick<
    LockedRepositories,
    "brokers" | "listings" | "contentRuns" | "contents" | "platformAccounts"
  >,
) {
  const brokerId = (await repos.brokers.create(brokerData(unique("pub")))).id;
  const listingId = (await repos.listings.create(newListing(brokerId, unique("P-PUB")))).id;
  const accountId = (await repos.platformAccounts.upsertConnected(connectedAccount(brokerId))).id;
  const run = await repos.contentRuns.create({ listingId, texts: true });
  await repos.contentRuns.markRunning(run.id);
  await repos.contentRuns.markSucceeded(run.id, {
    report: { warnings: [] },
    contents: [newContent("instagram")],
  });
  const [content] = await repos.contents.listCurrent(listingId);
  return { listingId, accountId, contentId: content?.id ?? "" };
}

async function pglite() {
  const database = await createTestDatabase();
  databases.push(database);
  const { db } = database;
  const repos = {
    brokers: createBrokerRepository(db),
    listings: createListingRepository(db),
    contentRuns: createContentRunRepository(db),
    contents: createContentRepository(db),
    platformAccounts: createPlatformAccountRepository(db, { secretBox }),
    publications: createPublicationRepository(db),
    media: createMediaRepository(db),
  };
  return { db, repos, lock: createListingLock(db, { secretBox }) };
}

function inMemory() {
  const brokers = createInMemoryBrokerRepository();
  const listings = createInMemoryListingRepository();
  const { contentRuns, contents } = createInMemoryContentRepositories();
  const repos: LockedRepositories = {
    brokers,
    listings,
    media: createInMemoryMediaRepository(),
    contentRuns,
    contents,
    publications: createInMemoryPublicationRepository(),
    platformAccounts: createInMemoryPlatformAccountRepository({ brokers }),
  };
  return { repos, lock: createInMemoryListingLock(repos) };
}

publicationRepositoryContract("en memoria", async () => {
  const { repos } = inMemory();
  return { publications: repos.publications, fixtures: () => seed(repos), missingId: MISSING_UUID };
});

publicationRepositoryContract("Drizzle sobre PGlite", async () => {
  const { repos } = await pglite();
  return { publications: repos.publications, fixtures: () => seed(repos), missingId: MISSING_UUID };
});

describe("publicaciones · lo que el puerto no muestra (PGlite)", () => {
  it("una fila con un progreso ajeno a su plataforma es PUBLICATION_ROW_INVALID, no un ZodError", async () => {
    const { db, repos } = await pglite();
    const ids = await seed(repos);
    const created = await repos.publications.create(
      {
        listingId: ids.listingId,
        platformAccountId: ids.accountId,
        platform: "instagram",
        format: "post",
        contentId: ids.contentId,
        mediaIds: [],
        dryRun: true,
      },
      { actor: "operator" },
    );
    await db
      .update(publications)
      .set({ progress: { otro: 1 } })
      .where(eq(publications.id, created.id));

    await expect(repos.publications.get(created.id)).rejects.toMatchObject({
      code: "PUBLICATION_ROW_INVALID",
      retriable: false,
    });
  });
});

/** Pruebas del candado que corren igual en memoria y en PGlite. */
function lockContract(
  name: string,
  make: () => Promise<{ repos: LockedRepositories; lock: ListingLock }>,
) {
  describe(`${name} · ListingLock`, () => {
    it("entrega los repositorios y devuelve lo que devuelve fn", async () => {
      const { repos, lock } = await make();
      const ids = await seed(repos);

      const result = await lock.run(ids.listingId, async (locked) => {
        const created = await locked.publications.create(
          {
            listingId: ids.listingId,
            platformAccountId: ids.accountId,
            platform: "instagram",
            format: "post",
            contentId: ids.contentId,
            mediaIds: [],
            dryRun: true,
          },
          { actor: "operator" },
        );
        await locked.publications.transition(
          created.id,
          { from: "approved", to: "publishing", changes: { incrementAttempts: true } },
          { actor: "operator" },
        );
        return created.id;
      });

      expect(await repos.publications.get(result)).toMatchObject({ status: "publishing" });
      // Dos eventos en la misma transacción quedan en el orden en que se escribieron.
      expect((await repos.publications.listEvents(result)).map((event) => event.toStatus)).toEqual([
        "approved",
        "publishing",
      ]);
    });

    it("un aviso que no existe es LISTING_NOT_FOUND, sin llamar a fn", async () => {
      const { lock } = await make();
      let called = false;

      await expect(
        lock.run(MISSING_UUID, async () => {
          called = true;
        }),
      ).rejects.toMatchObject({ code: "LISTING_NOT_FOUND" });
      expect(called).toBe(false);
    });
  });
}

lockContract("en memoria", async () => inMemory());
lockContract("Drizzle sobre PGlite", async () => pglite());

describe("ListingLock · Postgres (PGlite)", () => {
  it("si fn falla, se deshace todo lo que escribió", async () => {
    const { repos, lock } = await pglite();
    const ids = await seed(repos);

    await expect(
      lock.run(ids.listingId, async (locked) => {
        await locked.publications.create(
          {
            listingId: ids.listingId,
            platformAccountId: ids.accountId,
            platform: "instagram",
            format: "post",
            contentId: ids.contentId,
            mediaIds: [],
            dryRun: true,
          },
          { actor: "operator" },
        );
        await locked.contents.update(
          (await locked.contents.listCurrent(ids.listingId))[0]?.id ?? "",
          {
            status: "approved",
          },
        );
        throw new Error("falla después de escribir");
      }),
    ).rejects.toThrow("falla después de escribir");

    expect(await repos.publications.listByListing(ids.listingId)).toEqual([]);
    expect((await repos.contents.listCurrent(ids.listingId))[0]?.status).toBe("draft");
  });

  it("las transacciones propias de los repositorios funcionan dentro (savepoints)", async () => {
    const { repos, lock } = await pglite();
    const ids = await seed(repos);
    const run = await repos.contentRuns.create({ listingId: ids.listingId, texts: true });
    await repos.contentRuns.markRunning(run.id);

    const saved = await lock.run(ids.listingId, (locked) =>
      locked.contentRuns.markSucceeded(run.id, {
        report: { warnings: [] },
        contents: [newContent("portal_inmobiliario")],
      }),
    );

    expect(saved).toBe(true);
    expect((await repos.contentRuns.get(run.id))?.status).toBe("succeeded");
  });

  it("un conflicto dentro de fn deshace también lo anterior de esa transacción", async () => {
    const { repos, lock } = await pglite();
    const ids = await seed(repos);
    const input = {
      listingId: ids.listingId,
      platformAccountId: ids.accountId,
      platform: "instagram" as const,
      format: "post" as const,
      contentId: ids.contentId,
      mediaIds: [],
      dryRun: true,
    };

    await expect(
      lock.run(ids.listingId, async (locked) => {
        await locked.publications.create({ ...input, format: "reel" }, { actor: "operator" });
        await locked.publications.create(input, { actor: "operator" });
        await locked.publications.create(input, { actor: "operator" });
      }),
    ).rejects.toMatchObject({ code: "PUBLICATION_CONFLICT" });
    expect(await repos.publications.listByListing(ids.listingId)).toEqual([]);
  });
});

describe("ListingLock · en memoria", () => {
  it("serializa dos run del mismo aviso: el segundo empieza cuando termina el primero", async () => {
    const { repos, lock } = inMemory();
    const ids = await seed(repos);
    const other = await seed(repos);
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = lock.run(ids.listingId, async () => {
      order.push("primero empieza");
      await firstBlocked;
      order.push("primero termina");
    });
    const second = lock.run(ids.listingId, async () => {
      order.push("segundo");
    });
    // Otro aviso no espera.
    await lock.run(other.listingId, async () => {
      order.push("otro aviso");
    });
    expect(order).toEqual(["primero empieza", "otro aviso"]);
    expect(lock.busy()).toContain(ids.listingId);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["primero empieza", "otro aviso", "primero termina", "segundo"]);
    expect(lock.busy()).toEqual([]);
  });

  it("un run que falla no traba los siguientes", async () => {
    const { repos, lock } = inMemory();
    const ids = await seed(repos);

    await expect(
      lock.run(ids.listingId, async () => {
        throw new Error("falla");
      }),
    ).rejects.toThrow("falla");
    await expect(lock.run(ids.listingId, async () => "sigue")).resolves.toBe("sigue");
  });
});
