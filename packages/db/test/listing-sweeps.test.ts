import { createSecretBox } from "@agentsales/config";
import { listingSubject } from "@agentsales/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrokerRepository } from "../src/repositories/brokers.js";
import { createContentRunRepository } from "../src/repositories/content-runs.js";
import { createContentRepository } from "../src/repositories/contents.js";
import { createListingRepository } from "../src/repositories/listings.js";
import { createPlatformAccountRepository } from "../src/repositories/platform-accounts.js";
import { createPublicationRepository } from "../src/repositories/publications.js";
import { contentRuns, contents, posts, publications } from "../src/schema.js";
import { newContent } from "./content-repositories.contract.js";
import { brokerData, newListing } from "./import-repositories.contract.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";
import { connectedAccount } from "./platform-accounts.contract.js";

// F9-T04 (revisión de T03): los barridos recorren toda la tabla. Una fila de un post (`listing_id`
// nulo, ADR-0029) no debe romperlos. Los de corridas siguen siendo de avisos; desde F9-T06 los de
// publicaciones ven también las de posts (se reencolan al arrancar y la vigilancia las ve), y quien
// solo trabaja con avisos filtra por su cuenta.

let database: TestDatabase;
afterAll(async () => {
  await database.close();
});

describe("barridos de avisos con filas de posts en la tabla (PGlite)", () => {
  const secretBox = createSecretBox("k".repeat(32));
  let repos: {
    contentRuns: ReturnType<typeof createContentRunRepository>;
    publications: ReturnType<typeof createPublicationRepository>;
  };
  const listingIds: { queuedRun: string; pendingRun: string; due: string; stale: string } = {
    queuedRun: "",
    pendingRun: "",
    due: "",
    stale: "",
  };
  const postIds: { due: string; stale: string } = { due: "", stale: "" };
  const now = new Date();
  const longAgo = new Date(now.getTime() - 60 * 60 * 1000);

  beforeAll(async () => {
    database = await createTestDatabase();
    const { db } = database;
    const brokers = createBrokerRepository(db);
    const listings = createListingRepository(db);
    const accounts = createPlatformAccountRepository(db, { secretBox });
    repos = {
      contentRuns: createContentRunRepository(db),
      publications: createPublicationRepository(db),
    };
    const contentRepo = createContentRepository(db);

    const brokerId = (await brokers.create(brokerData("barridos"))).id;
    const accountId = (await accounts.upsertConnected(connectedAccount(brokerId))).id;

    // Un aviso con su corrida en `queued`.
    const queuedListing = (await listings.create(newListing(brokerId, "P-BARR-1"))).id;
    listingIds.queuedRun = (
      await repos.contentRuns.create({ listingId: queuedListing, texts: true })
    ).id;

    // Un aviso con su corrida terminada y el `auto_publish` sin resolver, y su texto.
    const pendingListing = (await listings.create(newListing(brokerId, "P-BARR-2"))).id;
    const pending = await repos.contentRuns.create({ listingId: pendingListing, texts: true });
    await repos.contentRuns.markRunning(pending.id);
    await repos.contentRuns.markSucceeded(pending.id, {
      report: { warnings: [] },
      contents: [newContent("instagram")],
    });
    listingIds.pendingRun = pending.id;
    const [listingText] = await contentRepo.listCurrent(listingSubject(pendingListing));

    // Dos publicaciones del aviso: una programada que vence y otra en `publishing` sin cambios.
    const listingPublication = (format: "post" | "reel") =>
      repos.publications.create(
        {
          listingId: pendingListing,
          platformAccountId: accountId,
          platform: "instagram",
          format,
          contentId: listingText?.id ?? "",
          mediaIds: [],
          listingSourceHash: "hash",
        },
        { actor: "system" },
      );
    const due = await listingPublication("post");
    await repos.publications.transition(
      due.id,
      {
        from: "approved",
        to: "scheduled",
        changes: { dryRun: true, scheduledAt: new Date(now.getTime() - 60_000) },
      },
      { actor: "system" },
    );
    listingIds.due = due.id;
    const stale = await listingPublication("reel");
    await repos.publications.transition(
      stale.id,
      { from: "approved", to: "publishing", changes: { dryRun: true, incrementAttempts: true } },
      { actor: "system" },
    );
    await db
      .update(publications)
      .set({ updatedAt: longAgo })
      .where(sql`${publications.id} = ${stale.id}`);
    listingIds.stale = stale.id;

    // Lo mismo para un post, escrito directo en la base (sin pasar por los repositorios).
    const [post] = await db
      .insert(posts)
      .values({ brokerId, topic: "Un post", kind: "text" })
      .returning({ id: posts.id });
    const postId = post?.id ?? "";
    await db.insert(contentRuns).values({ postId, status: "queued" });
    const [postRun] = await db
      .insert(contentRuns)
      .values({ postId, status: "succeeded", finishedAt: now })
      .returning({ id: contentRuns.id });
    const [postText] = await db
      .insert(contents)
      .values({
        ...newContent("instagram"),
        postId,
        contentRunId: postRun?.id ?? "",
        rawOutput: {},
      })
      .returning({ id: contents.id });
    const postPublication = {
      postId,
      platformAccountId: accountId,
      platform: "instagram" as const,
      contentId: postText?.id ?? "",
      mediaIds: [],
      dryRun: true,
    };
    const [postDue, postStale] = await db
      .insert(publications)
      .values([
        {
          ...postPublication,
          format: "post",
          status: "scheduled",
          scheduledAt: new Date(now.getTime() - 30_000),
        },
        { ...postPublication, format: "reel", status: "publishing", updatedAt: longAgo },
      ])
      .returning({ id: publications.id });
    postIds.due = postDue?.id ?? "";
    postIds.stale = postStale?.id ?? "";
  });

  it("listQueued y listAutoPublishPending ven solo las corridas de avisos", async () => {
    expect((await repos.contentRuns.listQueued()).map((run) => run.id)).toEqual([
      listingIds.queuedRun,
    ]);
    expect((await repos.contentRuns.listAutoPublishPending(longAgo)).map((run) => run.id)).toEqual([
      listingIds.pendingRun,
    ]);
  });

  it("listByStatus, listDue y listStalePublishing ven las de avisos y las de posts (F9-T06)", async () => {
    const byStatus = async (status: "scheduled" | "publishing") =>
      (await repos.publications.listByStatus(status)).map((item) => item.subject);
    expect(await byStatus("scheduled")).toEqual([
      { kind: "listing", id: expect.any(String) },
      { kind: "post", id: expect.any(String) },
    ]);
    expect((await repos.publications.listByStatus("scheduled")).map((item) => item.id)).toEqual([
      listingIds.due,
      postIds.due,
    ]);
    expect((await repos.publications.listByStatus("publishing")).map((item) => item.id)).toEqual([
      listingIds.stale,
      postIds.stale,
    ]);
    const due = await repos.publications.listDue({
      now,
      since: longAgo,
      excludePlatforms: [],
      limit: 10,
    });
    // Por hora: la del aviso venció antes que la del post.
    expect(due.map((item) => item.id)).toEqual([listingIds.due, postIds.due]);
    const stale = await repos.publications.listStalePublishing({
      before: new Date(now.getTime() - 60_000),
      excludePlatforms: [],
    });
    expect(stale.map((item) => item.id).sort()).toEqual([listingIds.stale, postIds.stale].sort());
  });
});
