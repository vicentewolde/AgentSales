import { createSecretBox } from "@agentsales/config";
import {
  type ListingLock,
  type LockedRepositories,
  type PostLock,
  type PostLockedRepositories,
  postSubject,
} from "@agentsales/core";
import {
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryEditorialProfileRepository,
  createInMemoryListingLock,
  createInMemoryListingRepository,
  createInMemoryMediaRepository,
  createInMemoryPlanRunRepository,
  createInMemoryPlatformAccountRepository,
  createInMemoryPostLock,
  createInMemoryPostRepository,
  createInMemoryPostUploadRepository,
  createInMemoryPublicationRepository,
} from "@agentsales/core/testing";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createPostLock } from "../src/post-lock.js";
import { createBrokerRepository } from "../src/repositories/brokers.js";
import { createContentRunRepository } from "../src/repositories/content-runs.js";
import { createContentRepository } from "../src/repositories/contents.js";
import { createEditorialProfileRepository } from "../src/repositories/editorial-profiles.js";
import { createListingRepository } from "../src/repositories/listings.js";
import { createMediaRepository } from "../src/repositories/media.js";
import { createPlanRunRepository } from "../src/repositories/plan-runs.js";
import { createPlatformAccountRepository } from "../src/repositories/platform-accounts.js";
import { createPostRepository, createPostUploadRepository } from "../src/repositories/posts.js";
import { createPublicationRepository } from "../src/repositories/publications.js";
import { contentRuns, contents, editorialProfiles, posts } from "../src/schema.js";
import { newContent } from "./content-repositories.contract.js";
import { brokerData } from "./import-repositories.contract.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";
import { connectedAccount } from "./platform-accounts.contract.js";
import { subjectRepositoriesContract } from "./subject-repositories.contract.js";

const MISSING_UUID = "00000000-0000-0000-0000-000000000000";
const secretBox = createSecretBox("k".repeat(32));

const databases: TestDatabase[] = [];
afterAll(async () => {
  await Promise.all(databases.map((database) => database.close()));
});

let sequence = 0;
const unique = (prefix: string) => `${prefix}-${++sequence}`;

function inMemory() {
  const brokers = createInMemoryBrokerRepository();
  const listings = createInMemoryListingRepository();
  const postRepo = createInMemoryPostRepository();
  const planRuns = createInMemoryPlanRunRepository();
  const { contentRuns: runs, contents: texts } = createInMemoryContentRepositories({
    brokerOfListing: (id) => listings.all().find((listing) => listing.id === id)?.brokerId ?? null,
    brokerOfPost: async (id) => (await postRepo.get(id))?.brokerId ?? null,
    planRuns: () => planRuns.all(),
  });
  return {
    brokers,
    listings,
    posts: postRepo,
    postUploads: createInMemoryPostUploadRepository(),
    planRuns,
    editorialProfiles: createInMemoryEditorialProfileRepository(),
    contentRuns: runs,
    contents: texts,
    publications: createInMemoryPublicationRepository(),
    media: createInMemoryMediaRepository(),
    accounts: createInMemoryPlatformAccountRepository({ brokers }),
  };
}

/**
 * Una base compartida por los casos de este archivo (cada uno usa sus propios datos): crear una
 * base con todas las migraciones es lo caro de PGlite. Con `logger`, una propia.
 */
let shared: Promise<TestDatabase> | undefined;
const openDatabase = (options: Parameters<typeof createTestDatabase>[0]) => {
  if (options?.logger !== undefined) return createTestDatabase(options);
  shared ??= createTestDatabase();
  return shared;
};

async function pglite(options: Parameters<typeof createTestDatabase>[0] = {}) {
  const database = await openDatabase(options);
  if (!databases.includes(database)) databases.push(database);
  const { db } = database;
  return {
    db,
    brokers: createBrokerRepository(db),
    listings: createListingRepository(db),
    posts: createPostRepository(db),
    postUploads: createPostUploadRepository(db),
    planRuns: createPlanRunRepository(db),
    editorialProfiles: createEditorialProfileRepository(db),
    contentRuns: createContentRunRepository(db),
    contents: createContentRepository(db),
    publications: createPublicationRepository(db),
    media: createMediaRepository(db),
    accounts: createPlatformAccountRepository(db, { secretBox }),
  };
}

subjectRepositoriesContract("en memoria", async () => ({ ...inMemory(), missingId: MISSING_UUID }));
subjectRepositoriesContract("Drizzle sobre PGlite", async () => ({
  ...(await pglite()),
  missingId: MISSING_UUID,
}));

describe("repositorios con sujeto · lo que el puerto no muestra (PGlite)", () => {
  it("una fila con un idioma fuera de LANGUAGES es *_ROW_INVALID, no un ZodError", async () => {
    const repos = await pglite();
    const brokerId = (await repos.brokers.create(brokerData(unique("idioma")))).id;
    const post = await repos.posts.create({ brokerId, topic: "Un post", kind: "text" });
    const run = await repos.contentRuns.create({ postId: post.id, texts: true });
    const [text] = await repos.db
      .insert(contents)
      .values({
        ...newContent("instagram"),
        language: "fr",
        postId: post.id,
        contentRunId: run.id,
        rawOutput: {},
      })
      .returning({ id: contents.id });
    await expect(repos.contents.get(text?.id ?? "")).rejects.toMatchObject({
      code: "CONTENT_ROW_INVALID",
      retriable: false,
    });

    await repos.db.insert(editorialProfiles).values({ brokerId, languages: ["es", "pt"] });
    await expect(repos.editorialProfiles.get(brokerId)).rejects.toMatchObject({
      code: "EDITORIAL_PROFILE_ROW_INVALID",
    });
  });

  it("una referencia que no existe da su *_REFERENCE_INVALID", async () => {
    const repos = await pglite();
    await expect(
      repos.posts.create({ brokerId: MISSING_UUID, topic: "x", kind: "text" }),
    ).rejects.toMatchObject({ code: "POST_REFERENCE_INVALID" });
    await expect(
      repos.planRuns.create({
        brokerId: MISSING_UUID,
        periodStart: new Date(),
        periodEnd: new Date(),
        request: {},
      }),
    ).rejects.toMatchObject({ code: "PLAN_RUN_REFERENCE_INVALID" });
    await expect(
      repos.postUploads.create({
        postId: MISSING_UUID,
        objectPath: "posts/x/y.jpg",
        expectedBytes: 1,
        expiresAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: "POST_UPLOAD_REFERENCE_INVALID" });
    await expect(
      repos.editorialProfiles.upsert(MISSING_UUID, {
        languages: ["es"],
        audience: null,
        pillars: [],
        facts: [],
        avoid: [],
        cadence: {},
        defaultHashtags: [],
      }),
    ).rejects.toMatchObject({ code: "EDITORIAL_PROFILE_REFERENCE_INVALID" });
    const brokerId = (await repos.brokers.create(brokerData(unique("ref")))).id;
    const account = await repos.accounts.upsertConnected(connectedAccount(brokerId));
    const postRun = await repos.contentRuns.create({
      postId: (await repos.posts.create({ brokerId, topic: "x", kind: "text" })).id,
      texts: true,
    });
    await repos.contentRuns.markRunning(postRun.id);
    await repos.contentRuns.markSucceeded(postRun.id, {
      report: { warnings: [] },
      contents: [newContent("instagram")],
    });
    const [text] = await repos.db
      .select({ id: contents.id })
      .from(contents)
      .where(eq(contents.contentRunId, postRun.id));
    await expect(
      repos.publications.create(
        {
          postId: MISSING_UUID,
          platformAccountId: account.id,
          platform: "instagram",
          format: "post",
          contentId: text?.id ?? "",
          mediaIds: [],
        },
        { actor: "operator" },
      ),
    ).rejects.toMatchObject({ code: "PUBLICATION_REFERENCE_INVALID" });
  });

  it("markSucceeded de un post es todo o nada, como el de un aviso", async () => {
    const repos = await pglite();
    const brokerId = (await repos.brokers.create(brokerData(unique("rollback-post")))).id;
    const post = await repos.posts.create({ brokerId, topic: "x", kind: "text" });
    const run = await repos.contentRuns.create({ postId: post.id, texts: true });
    await repos.contentRuns.markRunning(run.id);
    const broken = newContent("x", { body: null as unknown as string });
    await expect(
      repos.contentRuns.markSucceeded(run.id, {
        report: { warnings: [] },
        contents: [newContent("instagram"), broken],
      }),
    ).rejects.toMatchObject({ code: "DB_QUERY_FAILED" });
    const [after] = await repos.db.select().from(contentRuns).where(eq(contentRuns.id, run.id));
    expect(after?.status).toBe("running");
    expect(await repos.contents.listCurrent(postSubject(post.id))).toEqual([]);
  });
});

/** Un post con una cuenta de su marca y un texto de Instagram. */
async function seedPost(
  repos: Pick<
    PostLockedRepositories,
    "brokers" | "posts" | "contentRuns" | "contents" | "platformAccounts"
  >,
) {
  const brokerId = (await repos.brokers.create(brokerData(unique("candado-post")))).id;
  const post = await repos.posts.create({ brokerId, topic: "Un post", kind: "image" });
  const accountId = (await repos.platformAccounts.upsertConnected(connectedAccount(brokerId))).id;
  const run = await repos.contentRuns.create({ postId: post.id, texts: true });
  await repos.contentRuns.markRunning(run.id);
  await repos.contentRuns.markSucceeded(run.id, {
    report: { warnings: [] },
    contents: [newContent("instagram")],
  });
  const [content] = await repos.contents.listCurrent(postSubject(post.id));
  return { brokerId, postId: post.id, accountId, contentId: content?.id ?? "" };
}

function inMemoryLock() {
  const base = inMemory();
  const repos: PostLockedRepositories = {
    brokers: base.brokers,
    posts: base.posts,
    postUploads: base.postUploads,
    media: base.media,
    contentRuns: base.contentRuns,
    contents: base.contents,
    publications: base.publications,
    platformAccounts: base.accounts,
  };
  const listingRepos: LockedRepositories = {
    brokers: base.brokers,
    listings: base.listings,
    media: base.media,
    contentRuns: base.contentRuns,
    contents: base.contents,
    publications: base.publications,
    platformAccounts: base.accounts,
  };
  const postLock = createInMemoryPostLock(repos);
  return {
    repos,
    lock: postLock as PostLock,
    postLock,
    listingLock: createInMemoryListingLock(listingRepos) as ListingLock,
  };
}

async function pgliteLock(options: Parameters<typeof createTestDatabase>[0] = {}) {
  const base = await pglite(options);
  const repos: PostLockedRepositories = {
    brokers: base.brokers,
    posts: base.posts,
    postUploads: base.postUploads,
    media: base.media,
    contentRuns: base.contentRuns,
    contents: base.contents,
    publications: base.publications,
    platformAccounts: base.accounts,
  };
  return { db: base.db, repos, lock: createPostLock(base.db, { secretBox }) };
}

/** Pruebas del candado del post que corren igual en memoria y en PGlite. */
function postLockContract(
  name: string,
  make: () => Promise<{ repos: PostLockedRepositories; lock: PostLock }>,
) {
  describe(`${name} · PostLock`, () => {
    it("entrega los repositorios y devuelve lo que devuelve fn", async () => {
      const { repos, lock } = await make();
      const ids = await seedPost(repos);
      const publicationId = await lock.run(ids.postId, async (locked) => {
        const created = await locked.publications.create(
          {
            postId: ids.postId,
            platformAccountId: ids.accountId,
            platform: "instagram",
            format: "post",
            contentId: ids.contentId,
            mediaIds: [],
          },
          { actor: "operator" },
        );
        await locked.posts.update(ids.postId, { status: "ready" });
        return created.id;
      });
      expect(await repos.publications.get(publicationId)).toMatchObject({
        subject: postSubject(ids.postId),
        status: "approved",
      });
      expect((await repos.posts.get(ids.postId))?.status).toBe("ready");
    });

    it("un post que no existe es POST_NOT_FOUND, sin llamar a fn", async () => {
      const { lock } = await make();
      let called = false;
      await expect(
        lock.run(MISSING_UUID, async () => {
          called = true;
        }),
      ).rejects.toMatchObject({ code: "POST_NOT_FOUND" });
      expect(called).toBe(false);
    });

    it("serializa dos operaciones sobre el mismo post: la segunda ve lo que dejó la primera", async () => {
      const { repos, lock } = await make();
      const ids = await seedPost(repos);
      const order: string[] = [];
      // Dos "aprobar" a la vez: cada una lee el estado y escribe; serializadas, no se pisan.
      const approve = (label: string) =>
        lock.run(ids.postId, async (locked) => {
          const current = await locked.posts.get(ids.postId);
          order.push(`${label} lee ${current?.status}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (current?.status === "draft") {
            await locked.posts.update(ids.postId, { status: "ready" });
            order.push(`${label} aprueba`);
          }
        });
      await Promise.all([approve("primera"), approve("segunda")]);
      expect(order).toEqual(["primera lee draft", "primera aprueba", "segunda lee ready"]);
    });
  });
}

postLockContract("en memoria", async () => inMemoryLock());
postLockContract("Drizzle sobre PGlite", async () => pgliteLock());

describe("PostLock · Postgres (PGlite)", () => {
  it("bloquea la fila del post (FOR NO KEY UPDATE en posts) y, si fn falla, deshace todo", async () => {
    const queries: string[] = [];
    const { repos, lock } = await pgliteLock({
      logger: { logQuery: (query) => queries.push(query) },
    });
    const ids = await seedPost(repos);
    queries.length = 0;

    await expect(
      lock.run(ids.postId, async (locked) => {
        await locked.posts.update(ids.postId, { topic: "Cambiado" });
        await locked.contents.update(ids.contentId, { status: "approved" });
        throw new Error("falla después de escribir");
      }),
    ).rejects.toThrow("falla después de escribir");

    expect(queries[0]).toMatch(/from "posts" where "posts"\."id" = \$1 for no key update/);
    expect((await repos.posts.get(ids.postId))?.topic).toBe("Un post");
    expect((await repos.contents.get(ids.contentId))?.status).toBe("draft");
  });

  it("las transacciones propias de los repositorios funcionan dentro (savepoints)", async () => {
    const { repos, lock } = await pgliteLock();
    const ids = await seedPost(repos);
    const run = await repos.contentRuns.create({ postId: ids.postId, texts: true });
    await repos.contentRuns.markRunning(run.id);
    const saved = await lock.run(ids.postId, (locked) =>
      locked.contentRuns.markSucceeded(run.id, {
        report: { warnings: [] },
        contents: [newContent("discord", { language: "en" })],
      }),
    );
    expect(saved).toBe(true);
    expect((await repos.contentRuns.get(run.id))?.status).toBe("succeeded");
  });
});

describe("PostLock · en memoria", () => {
  it("un post no espera a otro post ni al candado de un aviso con el mismo id", async () => {
    const { repos, postLock, listingLock } = inMemoryLock();
    const ids = await seedPost(repos);
    const other = await seedPost(repos);
    const order: string[] = [];
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = postLock.run(ids.postId, async () => {
      order.push("post empieza");
      await blocked;
      order.push("post termina");
    });
    await postLock.run(other.postId, async () => {
      order.push("otro post");
    });
    // El candado del aviso tiene sus propias colas: un id igual no lo hace esperar (el aviso no
    // existe, así que responde LISTING_NOT_FOUND de inmediato, sin esperar al post).
    await expect(listingLock.run(ids.postId, async () => "nunca")).rejects.toMatchObject({
      code: "LISTING_NOT_FOUND",
    });
    order.push("aviso con el mismo id");
    expect(order).toEqual(["post empieza", "otro post", "aviso con el mismo id"]);
    expect(postLock.busy()).toEqual([ids.postId]);
    release();
    await first;
    expect(postLock.busy()).toEqual([]);
  });

  it("un run que falla no traba los siguientes", async () => {
    const { repos, postLock } = inMemoryLock();
    const ids = await seedPost(repos);
    await expect(
      postLock.run(ids.postId, async () => {
        throw new Error("falla");
      }),
    ).rejects.toThrow("falla");
    await expect(postLock.run(ids.postId, async () => "sigue")).resolves.toBe("sigue");
  });
});

describe("posts y avisos conviven en la misma tabla (PGlite)", () => {
  it("un post escrito directo en la base se lee con su sujeto", async () => {
    const repos = await pglite();
    const brokerId = (await repos.brokers.create(brokerData(unique("directo")))).id;
    const [post] = await repos.db
      .insert(posts)
      .values({ brokerId, topic: "Directo", kind: "text" })
      .returning({ id: posts.id });
    const [run] = await repos.db
      .insert(contentRuns)
      .values({ postId: post?.id, status: "queued" })
      .returning({ id: contentRuns.id });
    expect(await repos.contentRuns.get(run?.id ?? "")).toMatchObject({
      subject: postSubject(post?.id ?? ""),
      listingId: null,
      status: "queued",
    });
  });
});
