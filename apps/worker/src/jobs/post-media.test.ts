import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryMediaProcessor,
  createInMemoryMediaRepository,
  createInMemoryMediaStorage,
  createInMemoryPlatformAccountRepository,
  createInMemoryPostLock,
  createInMemoryPostRepository,
  createInMemoryPostUploadRepository,
  createInMemoryPublicationRepository,
} from "@agentsales/core/testing";
import { describe, expect, it, onTestFinished } from "vitest";
import { captureLogger } from "../../test/content-fixture.js";
import { POST_MEDIA_QUEUE, postMediaJob } from "./post-media.js";
import { publicationsWatchJob } from "./publications-watch.js";
import { registerJobs, type WorkerBoss } from "./registry.js";

// F9-T10 (spec F9 §4.5): el job `post.media` y la limpieza de las subidas de posts en la vigilancia.

const text = (value: string) => Uint8Array.from(value, (char) => char.charCodeAt(0));
const sha = (n: number) => n.toString(16).padStart(64, "0");

async function tmpRoot() {
  const root = await mkdtemp(join(tmpdir(), "agentsales-post-media-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function setup() {
  const posts = createInMemoryPostRepository();
  const media = createInMemoryMediaRepository();
  const storage = createInMemoryMediaStorage();
  const post = await posts.create({ brokerId: "brand-1", topic: "Bastidores", kind: "video" });
  for (const [n, kind] of [
    [1, "image"],
    [2, "video"],
  ] as const) {
    const path = `posts/${post.id}/original/${sha(n)}.${kind === "image" ? "jpg" : "mp4"}`;
    await storage.put(path, text(`${kind}-${n}`), kind === "image" ? "image/jpeg" : "video/mp4");
    await media.create({
      listingId: null,
      postId: post.id,
      brokerId: "brand-1",
      kind,
      storagePath: path,
      mime: kind === "image" ? "image/jpeg" : "video/mp4",
      bytes: 7,
      checksum: sha(n),
      sortOrder: n,
      isCover: false,
    });
  }
  const root = await tmpRoot();
  const workDirs: string[] = [];
  const deps = {
    shared: { posts, media, storage },
    createProcessor: (workDir: string) => {
      workDirs.push(workDir);
      return createInMemoryMediaProcessor({ version: "1" });
    },
    tmpRoot: root,
    signal: new AbortController().signal,
  };
  return { deps, post, media, posts, root, workDirs };
}

const context = (logger: ReturnType<typeof captureLogger>["logger"]) => ({
  jobId: "job-1",
  logger,
  isLastAttempt: false,
  retryCount: 0,
});

describe("job post.media", () => {
  it("es stately (uno en cola y uno activo por post), con 2 reintentos con backoff y 30 min", () => {
    expect(POST_MEDIA_QUEUE).toEqual({
      policy: "stately",
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 1800,
    });
  });

  it("arma las variantes del post con un temporal propio del intento y lo borra al terminar", async () => {
    const t = await setup();
    const { logger, lines } = captureLogger();
    await postMediaJob(t.deps).run({ postId: t.post.id }, context(logger));

    const variants = (await t.media.listBySubject({ kind: "post", id: t.post.id }))
      .filter((item) => item.role === "processed")
      .map((item) => item.variant)
      .sort();
    expect(variants).toEqual(["ig_4x5", "ig_reel", "thumb", "thumb", "x_video"]);
    expect(t.workDirs).toHaveLength(1);
    expect(t.workDirs[0]?.startsWith(join(t.root, t.post.id))).toBe(true);
    expect(await readdir(t.root)).toEqual([]);
    expect(lines.find((line) => line.msg === "medios del post procesados")).toMatchObject({
      media: { processed: 2, existing: 0, failed: 0 },
    });
  });

  it("un post archivado se salta y lo registra; datos inválidos no corren", async () => {
    const t = await setup();
    await t.posts.archive(t.post.id);
    const { logger, lines } = captureLogger();
    await postMediaJob(t.deps).run({ postId: t.post.id }, context(logger));
    expect(lines.find((line) => line.msg === "post sin medios que procesar")).toMatchObject({
      reason: "archived",
    });
    await expect(
      postMediaJob(t.deps).run({ postId: "no-es-uuid" }, context(logger)),
    ).rejects.toMatchObject({ code: "JOB_PAYLOAD_INVALID" });
  });
});

describe("publications.watch · subidas de posts (F9-T10)", () => {
  it("borra de R2 y cierra las subidas de posts vencidas, y lo registra con sus ids", async () => {
    const brokers = createInMemoryBrokerRepository();
    const posts = createInMemoryPostRepository();
    const postUploads = createInMemoryPostUploadRepository();
    const media = createInMemoryMediaRepository();
    const content = createInMemoryContentRepositories();
    const publications = createInMemoryPublicationRepository();
    const platformAccounts = createInMemoryPlatformAccountRepository();
    const postLock = createInMemoryPostLock({
      brokers,
      posts,
      postUploads,
      media,
      contentRuns: content.contentRuns,
      contents: content.contents,
      publications,
      platformAccounts,
    });
    const storage = createInMemoryMediaStorage();
    const post = await posts.create({ brokerId: "brand-1", topic: "Bastidores", kind: "image" });
    const path = `posts/${post.id}/original/${sha(9)}.jpg`;
    await storage.put(path, text("a medias"), "image/jpeg");
    const now = new Date("2026-10-20T12:00:00Z");
    const upload = await postUploads.create({
      postId: post.id,
      objectPath: path,
      expectedBytes: 100,
      expiresAt: new Date(now.getTime() - 1000),
    });

    let work: Parameters<WorkerBoss["work"]>[2] | undefined;
    const boss: WorkerBoss = {
      createQueue: async () => {},
      updateQueue: async () => {},
      getQueue: async () => ({ policy: "exclusive" }),
      work: async (_name, _options, handler) => {
        work = handler;
        return "w1";
      },
      schedule: async () => {},
    };
    const { logger, lines } = captureLogger();
    const job = publicationsWatchJob({
      publications,
      platformAccounts,
      queue: { enqueue: async () => null },
      now: () => now,
      postUploadCleanup: { postUploads, postLock, storage },
    });
    await registerJobs(boss, [job], logger);
    await work?.([{ id: "job-1", data: {}, retryCount: 0, retryLimit: 1 }]);

    expect(storage.objects.has(path)).toBe(false);
    expect((await postUploads.get(upload.id))?.status).toBe("abandoned");
    expect(
      lines.find((line) => line.msg === "vigilancia: subidas de posts sin terminar borradas de R2"),
    ).toMatchObject({ level: 40, postUploadIds: [upload.id] });
  });
});
