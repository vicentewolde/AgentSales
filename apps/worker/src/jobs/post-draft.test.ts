import { randomUUID } from "node:crypto";
import { editorialProfileView, SAMPLE_SOCIAL_DRAFT } from "@agentsales/core";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryEditorialProfileRepository,
  createInMemoryJobQueue,
  createInMemoryLlmProvider,
  createInMemoryMediaRepository,
  createInMemoryPlatformAccountRepository,
  createInMemoryPostLock,
  createInMemoryPostRepository,
  createInMemoryPostUploadRepository,
  createInMemoryPublicationRepository,
  LLM_ERRORS,
  type ScriptedLlmResponse,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { captureLogger } from "../../test/content-fixture.js";
import {
  CONTENT_PREPARE_QUEUE,
  CONTENT_RUN_ABANDONED_AFTER_MS,
  requeueQueuedPostRuns,
} from "./content-prepare.js";
import { POST_DRAFT_QUEUE, postDraftJob } from "./post-draft.js";

// F9-T11 (spec F9 §4.9): el job `post.draft`, con la IA guionada (nunca la real).

const SPEND = {
  inputTokens: 2000,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 1000,
  requestId: "req_1",
};

async function setup(
  options: { llm?: ScriptedLlmResponse[]; apiLlm?: ScriptedLlmResponse[]; capUsd?: number } = {},
) {
  const usesApi = options.apiLlm !== undefined;
  const broker = contentBrokerFixture({
    kind: "brand",
    brandName: "AgentPey",
    operatorOwned: !usesApi,
    llmMonthlyCapUsd: options.capUsd ?? null,
  });
  const brokers = createInMemoryBrokerRepository([broker]);
  const posts = createInMemoryPostRepository();
  const post = await posts.create({
    brokerId: broker.id,
    topic: "Bastidores",
    kind: "text",
    brief: "El texto secreto del brief",
  });
  const editorialProfiles = createInMemoryEditorialProfileRepository();
  await editorialProfiles.upsert(broker.id, {
    ...editorialProfileView(broker.id, null),
    cadence: { discord: { postsPerWeek: 1, days: [], hours: [], languageGapHours: 6 } },
  });
  const media = createInMemoryMediaRepository();
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const { contents, contentRuns } = createInMemoryContentRepositories({
    nextId: () => randomUUID(),
    brokerOfPost: async (postId) => (await posts.get(postId))?.brokerId ?? null,
  });
  const postLock = createInMemoryPostLock({
    brokers,
    posts,
    postUploads: createInMemoryPostUploadRepository(),
    media,
    contentRuns,
    contents,
    publications: createInMemoryPublicationRepository(),
    platformAccounts,
  });
  const llm = createInMemoryLlmProvider(options.llm ?? [], "claude-cli");
  const apiLlm = usesApi ? createInMemoryLlmProvider(options.apiLlm ?? [], "anthropic-api") : null;
  const run = await contentRuns.create({ postId: post.id, texts: true });
  const deps = {
    shared: {
      contentRuns,
      posts,
      brokers,
      editorialProfiles,
      platformAccounts,
      media,
      postLock,
      llm,
      apiLlm,
    },
    signal: new AbortController().signal,
  };
  return { deps, run, post, contentRuns, contents, llm, apiLlm, posts };
}

const context = (logger: ReturnType<typeof captureLogger>["logger"], isLastAttempt = false) => ({
  jobId: "job-1",
  logger,
  isLastAttempt,
  retryCount: 0,
});

describe("job post.draft", () => {
  it("es exclusive, con 2 reintentos con backoff, y cabe con ellos en las 2 h de failAbandoned", () => {
    expect(POST_DRAFT_QUEUE).toEqual({
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 1500,
    });
    // Tres intentos completos más el backoff (30 s y 60 s).
    const worstCaseMs =
      ((POST_DRAFT_QUEUE.retryLimit + 1) * POST_DRAFT_QUEUE.expireInSeconds + 30 + 60) * 1000;
    expect(worstCaseMs).toBeLessThan(CONTENT_RUN_ABANDONED_AFTER_MS);
    // Y dos llamadas con el tope máximo de LLM_TIMEOUT_SECONDS (600 s) caben en un intento.
    expect(2 * 600).toBeLessThan(POST_DRAFT_QUEUE.expireInSeconds);
    expect(CONTENT_RUN_ABANDONED_AFTER_MS).toBe(2 * 60 * 60 * 1000);
    expect(CONTENT_PREPARE_QUEUE.policy).toBe("exclusive");
  });

  it("redacta los textos y registra solo conteos y códigos, nunca el texto ni el brief", async () => {
    const t = await setup({ llm: [{ data: SAMPLE_SOCIAL_DRAFT }] });
    const { logger, lines } = captureLogger();

    await postDraftJob(t.deps).run({ contentRunId: t.run.id }, context(logger));

    expect((await t.contentRuns.get(t.run.id))?.status).toBe("succeeded");
    expect(
      (await t.contents.listCurrent({ kind: "post", id: t.post.id })).map(
        (content) => `${content.platform}:${content.language}:${content.status}`,
      ),
    ).toEqual(["discord:es:draft"]);
    const done = lines.find((line) => line.msg === "textos del post redactados");
    expect(done).toMatchObject({
      postStatus: "draft",
      texts: 1,
      withChecks: 0,
      warnings: 0,
      llm: { provider: "claude-cli", attempts: 1 },
    });
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain("secreto");
    expect(logged).not.toContain("reflexión");
  });

  it("un error reintentable sube para que pg-boss reintente, y el reintento termina la corrida", async () => {
    const t = await setup({
      llm: [{ error: LLM_ERRORS.unavailable() }, { data: SAMPLE_SOCIAL_DRAFT }],
    });
    const { logger } = captureLogger();

    await expect(
      postDraftJob(t.deps).run({ contentRunId: t.run.id }, context(logger)),
    ).rejects.toMatchObject({ code: "LLM_UNAVAILABLE", retriable: true });
    expect((await t.contentRuns.get(t.run.id))?.status).toBe("running");

    await postDraftJob(t.deps).run({ contentRunId: t.run.id }, context(logger, true));
    expect((await t.contentRuns.get(t.run.id))?.status).toBe("succeeded");
  });

  it("con el tope de IA alcanzado no llama a la IA y la corrida queda failed", async () => {
    const t = await setup({
      capUsd: 0.01,
      apiLlm: [{ data: SAMPLE_SOCIAL_DRAFT, model: "claude-sonnet-5-5", usage: SPEND }],
    });
    const { logger } = captureLogger();
    // La primera corrida gasta US$0,014; la segunda ya estaba en cola.
    await postDraftJob(t.deps).run({ contentRunId: t.run.id }, context(logger));
    const second = await t.contentRuns.create({ postId: t.post.id, texts: true });

    await expect(
      postDraftJob(t.deps).run({ contentRunId: second.id }, context(logger)),
    ).rejects.toMatchObject({ code: "LLM_BUDGET_EXCEEDED" });

    expect(t.apiLlm?.requests).toHaveLength(1);
    expect((await t.contentRuns.get(second.id))?.error?.code).toBe("LLM_BUDGET_EXCEEDED");
    expect((await t.contentRuns.get(t.run.id))?.llmUsage?.costUsd).toBe(0.014);
  });

  it("una corrida terminada se salta; datos inválidos no corren", async () => {
    const t = await setup();
    await t.contentRuns.markFailed(t.run.id, { code: "X", message: "x" });
    const { logger, lines } = captureLogger();

    await postDraftJob(t.deps).run({ contentRunId: t.run.id }, context(logger));

    expect(lines.find((line) => line.msg?.toString().includes("ya había terminado"))).toMatchObject(
      {
        status: "failed",
      },
    );
    await expect(
      postDraftJob(t.deps).run({ contentRunId: "no-es-uuid" }, context(logger)),
    ).rejects.toMatchObject({ code: "JOB_PAYLOAD_INVALID" });
  });

  it("al arrancar, las corridas de posts en cola se reencolan como post.draft", async () => {
    const t = await setup();
    const queue = createInMemoryJobQueue();

    expect(await requeueQueuedPostRuns(t.contentRuns, queue)).toEqual({ requeued: 1, failed: [] });
    expect(queue.jobs).toEqual([
      {
        name: "post.draft",
        data: { contentRunId: t.run.id },
        options: { singletonKey: t.run.id },
      },
    ]);
  });
});
