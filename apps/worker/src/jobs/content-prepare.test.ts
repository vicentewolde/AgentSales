import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError, type LLMProvider, type RunImportDeps } from "@agentsales/core";
import {
  createInMemoryContentRepositories,
  createInMemoryJobQueue,
  createInMemoryLlmProvider,
  LLM_ERRORS,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { captureLogger, contentJobSetup, silentLogger } from "../../test/content-fixture.js";
import {
  CONTENT_PREPARE_QUEUE,
  CONTENT_RUN_ABANDONED_AFTER_MS,
  contentPrepareJob,
  failAbandonedContentRuns,
  requeueQueuedContentRuns,
} from "./content-prepare.js";
import { buildJobs } from "./index.js";
import type { PublicationPublishJobDeps } from "./publication-publish.js";
import { registerJobs, type WorkerBoss } from "./registry.js";
import type { TokensRefreshJobDeps } from "./tokens-refresh.js";

const context = (isLastAttempt: boolean) => ({
  jobId: "j1",
  logger: silentLogger,
  isLastAttempt,
  retryCount: 0,
});

/** Una IA que espera el corte y responde como el adaptador: `LLM_ABORTED`. */
function waitingLlm(onCall: () => void): LLMProvider {
  return {
    name: "fake",
    generateStructured: ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () =>
            reject(new AppError("LLM_ABORTED", "Se cortó la llamada a la IA", { retriable: true })),
          { once: true },
        );
        onCall();
      }),
  };
}

describe("job content.prepare · cola", () => {
  it("es exclusive (deduplica por contentRunId), con 2 reintentos con backoff y 30 min", async () => {
    expect(CONTENT_PREPARE_QUEUE).toEqual({
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 1800,
    });
    // 3 intentos de 30 min y media hora de margen.
    expect(CONTENT_RUN_ABANDONED_AFTER_MS).toBe(2 * 60 * 60 * 1000);
    const { deps } = await contentJobSetup();
    // Solo se miran los nombres: `import.run` no usa sus dependencias hasta correr.
    expect(
      buildJobs({
        importRun: {} as RunImportDeps,
        contentPrepare: deps,
        publicationPublish: {} as PublicationPublishJobDeps,
        tokensRefresh: {} as TokensRefreshJobDeps,
      }).map((job) => job.name),
    ).toEqual([
      "system.ping",
      "import.run",
      "content.prepare",
      "publication.publish",
      "tokens.refresh",
    ]);
  });
});

describe("job content.prepare · handler", () => {
  it("prepara el contenido con un temporal propio del intento y lo borra al terminar", async () => {
    const t = await contentJobSetup();
    const runId = await t.newRun();

    await contentPrepareJob(t.deps).run({ contentRunId: runId }, context(false));

    expect(await t.contentRuns.get(runId)).toMatchObject({ status: "succeeded" });
    // Un mismo directorio para todo el intento, dentro de <raíz>/{runId}/{uuid}/.
    const dirs = new Set(t.workDirs.map((dir) => dir.path));
    expect(dirs.size).toBe(1);
    expect([...dirs][0]).toMatch(new RegExp(`^${t.tmpRoot}/${runId}/[0-9a-f-]{36}$`));
    expect(t.workDirs.every((dir) => dir.existed)).toBe(true);
    // Borrado, y también el de la corrida, que quedó vacío.
    expect(await readdir(t.tmpRoot)).toEqual([]);
  });

  it("con datos que no son un uuid: JOB_PAYLOAD_INVALID, sin crear temporales", async () => {
    const t = await contentJobSetup();

    await expect(
      contentPrepareJob(t.deps).run({ contentRunId: "run-1" }, context(true)),
    ).rejects.toMatchObject({ code: "JOB_PAYLOAD_INVALID", retriable: false });
    expect(await readdir(t.tmpRoot)).toEqual([]);
  });

  it("un error no reintentable deja la corrida en failed y borra el temporal", async () => {
    const t = await contentJobSetup({
      llm: createInMemoryLlmProvider([{ error: LLM_ERRORS.authRequired() }]),
    });
    const runId = await t.newRun();

    await expect(
      contentPrepareJob(t.deps).run({ contentRunId: runId }, context(false)),
    ).rejects.toMatchObject({ code: "LLM_AUTH_REQUIRED", retriable: false });
    expect(await t.contentRuns.get(runId)).toMatchObject({
      status: "failed",
      error: { code: "LLM_AUTH_REQUIRED" },
    });
    expect(t.workDirs).not.toHaveLength(0);
    expect(await readdir(t.tmpRoot)).toEqual([]);
  });

  it.each([
    [false, "running"],
    [true, "failed"],
  ])("un error reintentable con isLastAttempt %s deja la corrida en %s", async (last, status) => {
    const t = await contentJobSetup({
      llm: createInMemoryLlmProvider([{ error: LLM_ERRORS.unavailable() }]),
    });
    const runId = await t.newRun();

    await expect(
      contentPrepareJob(t.deps).run({ contentRunId: runId }, context(last)),
    ).rejects.toMatchObject({ code: "LLM_UNAVAILABLE", retriable: true });
    expect(await t.contentRuns.get(runId)).toMatchObject({ status });
    expect(await readdir(t.tmpRoot)).toEqual([]);
  });

  it("un error que no es AppError termina en INTERNAL_ERROR y el temporal se borra igual", async () => {
    const t = await contentJobSetup();
    const createProcessor = t.deps.createProcessor;
    t.deps.createProcessor = (workDir) => {
      const inner = createProcessor(workDir);
      return {
        ...inner,
        processImage: async (...args) => {
          await inner.processImage(...args); // deja un archivo en el temporal
          throw new TypeError("se cayó el procesador");
        },
      };
    };
    const runId = await t.newRun();

    await expect(
      contentPrepareJob(t.deps).run({ contentRunId: runId }, context(false)),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR", retriable: false });
    expect(await t.contentRuns.get(runId)).toMatchObject({ status: "failed" });
    expect(await readdir(t.tmpRoot)).toEqual([]);
  });

  it("un corte en el último intento no deja la corrida en failed: sigue en running", async () => {
    let t: Awaited<ReturnType<typeof contentJobSetup>> | undefined;
    t = await contentJobSetup({ llm: waitingLlm(() => t?.abort.abort()) });
    const runId = await t.newRun();

    await expect(
      contentPrepareJob(t.deps).run({ contentRunId: runId }, context(true)),
    ).rejects.toMatchObject({ code: "LLM_ABORTED", retriable: true });
    expect(await t.contentRuns.get(runId)).toMatchObject({ status: "running", error: null });
    expect(await readdir(t.tmpRoot)).toEqual([]);
  });

  it.each([
    [false, "queued"],
    [true, "failed"],
  ])(
    "sin carpeta temporal (isLastAttempt %s): CONTENT_TMP_UNAVAILABLE y la corrida en %s",
    async (last, status) => {
      const t = await contentJobSetup();
      // Un archivo donde iría la carpeta: `mkdir` falla, como con el disco lleno.
      const blocked = join(t.tmpRoot, "archivo");
      await writeFile(blocked, "x");
      t.deps.tmpRoot = blocked;
      const runId = await t.newRun();

      await expect(
        contentPrepareJob(t.deps).run({ contentRunId: runId }, context(last)),
      ).rejects.toMatchObject({ code: "CONTENT_TMP_UNAVAILABLE", retriable: true });
      expect(await t.contentRuns.get(runId)).toMatchObject({
        status,
        error: last ? { code: "CONTENT_TMP_UNAVAILABLE" } : null,
      });
      expect(t.workDirs).toEqual([]);
    },
  );

  it("con el corte, un error no reintentable se relanza como CONTENT_RUN_ABORTED (reintentable)", async () => {
    let t: Awaited<ReturnType<typeof contentJobSetup>> | undefined;
    const llm: LLMProvider = {
      name: "fake",
      async generateStructured() {
        t?.abort.abort();
        throw LLM_ERRORS.authRequired(); // la CLI murió por el corte con otro mensaje
      },
    };
    t = await contentJobSetup({ llm });
    const runId = await t.newRun();

    await expect(
      contentPrepareJob(t.deps).run({ contentRunId: runId }, context(true)),
    ).rejects.toMatchObject({
      code: "CONTENT_RUN_ABORTED",
      retriable: true,
      cause: expect.objectContaining({ code: "LLM_AUTH_REQUIRED" }),
    });
    expect(await t.contentRuns.get(runId)).toMatchObject({ status: "running" });
  });

  it("el log del error lleva solo el código y el contentRunId, nunca datos del aviso", async () => {
    const t = await contentJobSetup({
      llm: createInMemoryLlmProvider([
        {
          error: new AppError("LLM_UNAVAILABLE", "La IA citó: Avenida Secreta 123", {
            retriable: true,
            cause: new Error("Avenida Secreta 123, depto 45"),
          }),
        },
      ]),
    });
    const runId = await t.newRun();
    const { logger, lines } = captureLogger();
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
    await registerJobs(boss, [contentPrepareJob(t.deps)], logger);

    await expect(
      work?.([{ id: "j1", data: { contentRunId: runId }, retryCount: 0, retryLimit: 2 }]),
    ).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });

    const errors = lines.filter((line) => line.level === 50);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "LLM_UNAVAILABLE", data: { contentRunId: runId } });
    expect(errors[0]).not.toHaveProperty("err");
    expect(JSON.stringify(lines)).not.toContain("Secreta");
  });
});

describe("job content.prepare · arranque", () => {
  it("cierra como failed las corridas en running de hace más de 2 h; no toca las demás", async () => {
    const repos = createInMemoryContentRepositories();
    const old = await repos.contentRuns.create({ listingId: "l1", texts: true });
    await repos.contentRuns.markRunning(old.id);
    const queued = await repos.contentRuns.create({ listingId: "l2", texts: true });
    const started = (await repos.contentRuns.get(old.id))?.startedAt?.getTime() ?? 0;

    // Recién empezada: no es abandonada.
    expect(await failAbandonedContentRuns(repos.contentRuns, started + 60_000)).toEqual([]);
    // Pasadas 2 h y un poco más.
    const closed = await failAbandonedContentRuns(
      repos.contentRuns,
      started + CONTENT_RUN_ABANDONED_AFTER_MS + 1,
    );

    expect(closed).toEqual([old.id]);
    expect(await repos.contentRuns.get(old.id)).toMatchObject({
      status: "failed",
      error: { code: "CONTENT_RUN_ABANDONED" },
    });
    expect(await repos.contentRuns.get(queued.id)).toMatchObject({ status: "queued" });
  });

  it("reencola todas las corridas en queued con su singletonKey", async () => {
    const repos = createInMemoryContentRepositories();
    const first = await repos.contentRuns.create({ listingId: "l1", texts: true });
    const second = await repos.contentRuns.create({ listingId: "l2", texts: false });
    const running = await repos.contentRuns.create({ listingId: "l3", texts: true });
    await repos.contentRuns.markRunning(running.id);
    const queue = createInMemoryJobQueue();

    expect(await requeueQueuedContentRuns(repos.contentRuns, queue)).toEqual({
      requeued: 2,
      failed: [],
    });
    expect(queue.jobs).toEqual([
      {
        name: "content.prepare",
        data: { contentRunId: first.id },
        options: { singletonKey: first.id },
      },
      {
        name: "content.prepare",
        data: { contentRunId: second.id },
        options: { singletonKey: second.id },
      },
    ]);
  });

  it("si una corrida no se puede reencolar, sigue con las demás y la informa", async () => {
    const repos = createInMemoryContentRepositories();
    const first = await repos.contentRuns.create({ listingId: "l1", texts: true });
    const second = await repos.contentRuns.create({ listingId: "l2", texts: true });
    let calls = 0;
    const queue = createInMemoryJobQueue({
      fail: () =>
        ++calls === 1
          ? new AppError("QUEUE_UNAVAILABLE", "No se pudo conectar a la cola", { retriable: true })
          : undefined,
    });

    expect(await requeueQueuedContentRuns(repos.contentRuns, queue)).toEqual({
      requeued: 1,
      failed: [first.id],
    });
    expect(queue.jobs.map((job) => job.data)).toEqual([{ contentRunId: second.id }]);
  });
});
