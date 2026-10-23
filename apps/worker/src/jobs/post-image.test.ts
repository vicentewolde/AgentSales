import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakeCardRenderer,
  createFakeImageGenerator,
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryJobQueue,
  createInMemoryMediaProcessor,
  createInMemoryMediaRepository,
  createInMemoryMediaStorage,
  createInMemoryPlatformAccountRepository,
  createInMemoryPostImageRunRepository,
  createInMemoryPostLock,
  createInMemoryPostRepository,
  createInMemoryPostUploadRepository,
  createInMemoryPublicationRepository,
} from "@agentsales/core/testing";
import { describe, expect, it, onTestFinished } from "vitest";
import { captureLogger } from "../../test/content-fixture.js";
import { IDLE_IGNORED_JOBS } from "../idle-exit.js";
import {
  failAbandonedPostImageRuns,
  POST_IMAGE_QUEUE,
  POST_IMAGE_RUN_ABANDONED_AFTER_MS,
  postImageJob,
  requeueQueuedPostImageRuns,
} from "./post-image.js";

// F9.5-T25: el job `post.image` con los dobles: consigue lo pedido con un temporal propio del
// intento, lo borra al terminar y no deja la indicación en el log.

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agentsales-post-image-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const brokers = createInMemoryBrokerRepository();
  const broker = await brokers.create(
    {
      slug: "agentpey",
      name: "Vinny",
      brandName: "AgentPey",
      primaryColor: "#123456",
      secondaryColor: "#abcdef",
      whatsapp: null,
      email: null,
      instagramHandle: null,
      website: null,
      tone: null,
      fixedHashtags: [],
    },
    { kind: "brand" },
  );
  const posts = createInMemoryPostRepository();
  const media = createInMemoryMediaRepository();
  const content = createInMemoryContentRepositories();
  const postLock = createInMemoryPostLock({
    brokers,
    posts,
    postUploads: createInMemoryPostUploadRepository(),
    media,
    contentRuns: content.contentRuns,
    contents: content.contents,
    publications: createInMemoryPublicationRepository(),
    platformAccounts: createInMemoryPlatformAccountRepository(),
  });
  const runs = createInMemoryPostImageRunRepository();
  const queue = createInMemoryJobQueue();
  const post = await posts.create({ brokerId: broker.id, topic: "Tema", kind: "image" });
  const workDirs: string[] = [];
  const deps = {
    shared: {
      runs,
      posts,
      brokers,
      contents: content.contents,
      media,
      storage: createInMemoryMediaStorage(),
      postLock,
      queue,
      cards: createFakeCardRenderer(),
      stock: null,
      ai: {
        generator: createFakeImageGenerator(),
        model: "nano-test",
        pricing: { priceUsd: 0.034, monthlyCapUsd: 2 },
      },
      sha256: () => "a".repeat(64),
    },
    createProcessor: (workDir: string) => {
      workDirs.push(workDir);
      return createInMemoryMediaProcessor({ version: "1" });
    },
    tmpRoot: root,
    signal: new AbortController().signal,
  };
  return { deps, root, runs, post, broker, media, workDirs };
}

const context = (logger: ReturnType<typeof captureLogger>["logger"]) => ({
  jobId: "job-1",
  logger,
  isLastAttempt: true,
  retryCount: 2,
});

describe("job post.image", () => {
  it("exclusivo por pedido, con 2 reintentos con backoff y 15 min", () => {
    expect(POST_IMAGE_QUEUE).toEqual({
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 900,
    });
  });

  it("consigue la imagen con un temporal propio del intento y lo borra al terminar", async () => {
    const t = await setup();
    const run = await t.runs.create({
      postId: t.post.id,
      brokerId: t.broker.id,
      source: "ai",
      request: { source: "ai", prompt: "indicación privada", format: "4:5" },
      createdBy: null,
    });
    const { logger, lines } = captureLogger();
    await postImageJob(t.deps).run({ postImageRunId: run.id }, context(logger));
    expect((await t.runs.get(run.id))?.status).toBe("succeeded");
    expect(await t.media.listOriginals({ kind: "post", id: t.post.id })).toHaveLength(1);
    expect(t.workDirs[0]?.startsWith(join(t.root, run.id))).toBe(true);
    expect(await readdir(t.root)).toEqual([]);
    expect(lines.find((line) => line.msg === "imágenes del post conseguidas")).toMatchObject({
      media: 1,
      created: 1,
    });
    expect(JSON.stringify(lines)).not.toContain("indicación privada");
  });

  it("un pedido que falla queda con su código en el log; uno terminado se salta", async () => {
    const t = await setup();
    const run = await t.runs.create({
      postId: t.post.id,
      brokerId: t.broker.id,
      source: "stock",
      request: { source: "stock", photoId: "1", query: "búsqueda privada", format: "4:5" },
      createdBy: null,
    });
    const { logger, lines } = captureLogger();
    await postImageJob(t.deps).run({ postImageRunId: run.id }, context(logger));
    expect(lines.find((line) => line.msg === "no se consiguió la imagen del post")).toMatchObject({
      code: "POST_IMAGE_SOURCE_NOT_CONFIGURED",
    });
    await postImageJob(t.deps).run({ postImageRunId: run.id }, context(logger));
    expect(lines.some((line) => String(line.msg).startsWith("el pedido de imágenes ya"))).toBe(
      true,
    );
    expect(JSON.stringify(lines)).not.toContain("búsqueda privada");
  });

  it("al arrancar: cierra los abandonados de más de 2 h y reencola los que esperan", async () => {
    const t = await setup();
    const card = { source: "card" as const, format: "4:5" as const };
    const queued = await t.runs.create({
      postId: t.post.id,
      brokerId: t.broker.id,
      source: "card",
      request: card,
      createdBy: null,
    });
    // Recién empezado: no es abandonado; con el reloj 2 h después, sí.
    const other = { id: "22222222-2222-4222-8222-222222222222" };
    const running = await t.runs.create({
      postId: other.id,
      brokerId: t.broker.id,
      source: "card",
      request: card,
      createdBy: null,
    });
    await t.runs.markRunning(running.id);
    expect(await failAbandonedPostImageRuns(t.runs)).toEqual([]);
    const later = Date.now() + POST_IMAGE_RUN_ABANDONED_AFTER_MS + 1000;
    expect(await failAbandonedPostImageRuns(t.runs, later)).toEqual([running.id]);
    expect(await t.runs.get(running.id)).toMatchObject({
      status: "failed",
      error: { code: "POST_IMAGE_RUN_ABANDONED" },
    });

    const queue = createInMemoryJobQueue();
    expect(await requeueQueuedPostImageRuns(t.runs, queue)).toEqual({ requeued: 1, failed: [] });
    expect(queue.jobs).toEqual([
      {
        name: "post.image",
        data: { postImageRunId: queued.id },
        options: { singletonKey: queued.id },
      },
    ]);
  });

  it("un post.image pendiente cuenta como trabajo: el worker no se apaga solo (T24)", () => {
    expect(IDLE_IGNORED_JOBS).not.toContain("post.image");
  });
});
