import { randomUUID } from "node:crypto";
import { editorialProfileView, PLAN_PROMPT_VERSION } from "@agentsales/core";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryEditorialProfileRepository,
  createInMemoryJobQueue,
  createInMemoryLlmProvider,
  createInMemoryPlanRunRepository,
  createInMemoryPostRepository,
  LLM_ERRORS,
  type ScriptedLlmResponse,
} from "@agentsales/core/testing";
import { createLlmProvider } from "@agentsales/llm";
import { describe, expect, it } from "vitest";
import { captureLogger } from "../../test/content-fixture.js";
import { planLlmProviderOptions } from "../llm-options.js";
import {
  CONTENT_PLAN_QUEUE,
  contentPlanJob,
  failAbandonedPlanRuns,
  PLAN_RUN_ABANDONED,
  PLAN_RUN_ABANDONED_AFTER_MS,
  requeueQueuedPlanRuns,
} from "./content-plan.js";

// F9-T20 (spec F9 §4.9): el job `content.plan`, con el plan de ejemplo del proveedor `fake` del
// worker o la IA guionada (nunca la real).

// Martes 20 de octubre de 2026, 12:00 en Chile.
const NOW = new Date("2026-10-20T15:00:00Z");

const env = {
  LLM_MODEL: "sonnet",
  CLAUDE_CLI_PATH: "/opt/claude",
  LLM_TIMEOUT_SECONDS: 180,
  ANTHROPIC_MODEL: "claude-sonnet-5-5",
  ANTHROPIC_API_KEY: undefined,
} as const;

async function setup(options: { llm?: ScriptedLlmResponse[] } = {}) {
  const broker = contentBrokerFixture({
    kind: "brand",
    brandName: "AgentPey",
    operatorOwned: true,
    fixedHashtags: [],
  });
  const brokers = createInMemoryBrokerRepository([broker]);
  const posts = createInMemoryPostRepository();
  const planRuns = createInMemoryPlanRunRepository({ posts });
  const editorialProfiles = createInMemoryEditorialProfileRepository();
  await editorialProfiles.upsert(broker.id, {
    ...editorialProfileView(broker.id, null),
    pillars: [{ key: "producto", name: "Producto", description: "Lo que hacemos", weight: 1 }],
    facts: ["El secreto de la marca: publica en Discord"],
    cadence: { discord: { postsPerWeek: 3, days: [], hours: ["18:00"], languageGapHours: 6 } },
  });
  const { contentRuns } = createInMemoryContentRepositories({
    planRuns: () => planRuns.all(),
  });
  // Por defecto, el `fake` del worker (el plan de ejemplo armado con el prompt).
  const llm =
    options.llm === undefined
      ? createLlmProvider(planLlmProviderOptions({ ...env, LLM_PROVIDER: "fake" }, {}))
      : createInMemoryLlmProvider(options.llm, "claude-cli");
  const run = await planRuns.create({
    brokerId: broker.id,
    periodStart: new Date("2026-10-21T03:00:00Z"),
    periodEnd: new Date("2026-11-04T03:00:00Z"),
    request: { platforms: ["discord"], count: 3, days: 14, requestedBy: null },
  });
  const deps = {
    shared: {
      planRuns,
      posts,
      brokers,
      editorialProfiles,
      contentRuns,
      llm,
      apiLlm: null,
      newId: randomUUID,
      clock: () => NOW,
    },
    signal: new AbortController().signal,
  };
  return { deps, run, planRuns, posts };
}

const context = (logger: ReturnType<typeof captureLogger>["logger"], isLastAttempt = false) => ({
  jobId: "job-1",
  logger,
  isLastAttempt,
  retryCount: 0,
});

describe("job content.plan", () => {
  it("es exclusive, con 2 reintentos con backoff, y cabe con ellos antes de darlo por abandonado", () => {
    expect(CONTENT_PLAN_QUEUE).toEqual({
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 1500,
    });
    const worstCaseMs =
      ((CONTENT_PLAN_QUEUE.retryLimit + 1) * CONTENT_PLAN_QUEUE.expireInSeconds + 30 + 60) * 1000;
    expect(worstCaseMs).toBeLessThan(PLAN_RUN_ABANDONED_AFTER_MS);
    expect(2 * 600).toBeLessThan(CONTENT_PLAN_QUEUE.expireInSeconds);
  });

  it("con fake: deja las ideas pedidas como posts idea y registra solo conteos y códigos", async () => {
    const t = await setup();
    const { logger, lines } = captureLogger();

    await contentPlanJob(t.deps).run({ planRunId: t.run.id }, context(logger));

    expect(await t.planRuns.get(t.run.id)).toMatchObject({
      status: "succeeded",
      promptVersion: PLAN_PROMPT_VERSION,
    });
    const ideas = await t.posts.list({ planRunId: t.run.id }, { kind: "all" });
    expect(ideas).toHaveLength(3);
    expect(ideas.every((post) => post.status === "idea" && post.briefOrigin === "ai")).toBe(true);
    const done = lines.find((line) => line.msg === "plan de ideas listo");
    expect(done).toMatchObject({
      ideas: 3,
      discarded: 0,
      discardCodes: [],
      llm: { provider: "fake", attempts: 1 },
    });
    // Nunca los temas ni el perfil en el log.
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain("secreto");
    for (const post of ideas) expect(logged).not.toContain(post.topic);
  });

  it("un error reintentable sube para que pg-boss reintente; en el último intento, failed", async () => {
    const t = await setup({
      llm: [{ error: LLM_ERRORS.unavailable() }, { error: LLM_ERRORS.unavailable() }],
    });
    const { logger } = captureLogger();

    await expect(
      contentPlanJob(t.deps).run({ planRunId: t.run.id }, context(logger)),
    ).rejects.toMatchObject({ code: "LLM_UNAVAILABLE", retriable: true });
    expect((await t.planRuns.get(t.run.id))?.status).toBe("running");

    await expect(
      contentPlanJob(t.deps).run({ planRunId: t.run.id }, context(logger, true)),
    ).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    expect(await t.planRuns.get(t.run.id)).toMatchObject({
      status: "failed",
      error: { code: "LLM_UNAVAILABLE" },
    });
  });

  it("un plan terminado se salta; datos inválidos no corren", async () => {
    const t = await setup();
    await t.planRuns.markFailed(t.run.id, { code: "X", message: "x" });
    const { logger, lines } = captureLogger();

    await contentPlanJob(t.deps).run({ planRunId: t.run.id }, context(logger));
    expect(lines.find((line) => line.msg?.toString().includes("ya había terminado"))).toMatchObject(
      { status: "failed" },
    );
    await expect(
      contentPlanJob(t.deps).run({ planRunId: "no-es-uuid" }, context(logger)),
    ).rejects.toMatchObject({ code: "JOB_PAYLOAD_INVALID" });
  });

  it("al arrancar, los planes en cola se reencolan y los abandonados se cierran", async () => {
    const t = await setup();
    const queue = createInMemoryJobQueue();
    expect(await requeueQueuedPlanRuns(t.planRuns, queue)).toEqual({ requeued: 1, failed: [] });
    expect(queue.jobs).toEqual([
      { name: "content.plan", data: { planRunId: t.run.id }, options: { singletonKey: t.run.id } },
    ]);

    // Uno que no se puede encolar no corta los demás.
    const down = createInMemoryJobQueue({ fail: () => LLM_ERRORS.unavailable() });
    expect(await requeueQueuedPlanRuns(t.planRuns, down)).toEqual({
      requeued: 0,
      failed: [t.run.id],
    });

    await t.planRuns.markRunning(t.run.id);
    // Recién empezado: no se cierra.
    expect(await failAbandonedPlanRuns(t.planRuns)).toEqual([]);
    expect(
      await failAbandonedPlanRuns(t.planRuns, Date.now() + PLAN_RUN_ABANDONED_AFTER_MS + 1),
    ).toEqual([t.run.id]);
    expect(await t.planRuns.get(t.run.id)).toMatchObject({
      status: "failed",
      error: PLAN_RUN_ABANDONED,
    });
  });
});
