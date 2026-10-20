import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  type AutoPublishDeps,
  type LLMProvider,
  type RunImportDeps,
} from "@agentsales/core";
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
  requeueQueuedPostRuns,
  resumeAutoPublishAtStart,
} from "./content-prepare.js";
import type { DbBackupJobDeps } from "./db-backup.js";
import { buildJobs } from "./index.js";
import type { MarketplaceProfileJobDeps } from "./marketplace-profile.js";
import type { PublicationDueJobDeps } from "./publication-due.js";
import type { PublicationPublishJobDeps } from "./publication-publish.js";
import type { PublicationSyncJobDeps } from "./publication-sync.js";
import type { PublicationsWatchJobDeps } from "./publications-watch.js";
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
        publicationSync: {} as PublicationSyncJobDeps,
        tokensRefresh: {} as TokensRefreshJobDeps,
        marketplaceProfile: {} as MarketplaceProfileJobDeps,
        publicationDue: {} as PublicationDueJobDeps,
        publicationsWatch: {} as PublicationsWatchJobDeps,
        dbBackup: {} as DbBackupJobDeps,
      }).map((job) => job.name),
    ).toEqual([
      "system.ping",
      "import.run",
      "content.prepare",
      "publication.publish",
      "publication.sync",
      "tokens.refresh",
      "marketplace.profile",
      "publication.due",
      "publications.watch",
      "db.backup",
    ]);
  });
});

describe("jobs · Marketplace en producción (F8-T20, D4)", () => {
  it("sin el perfil del navegador (null) no se registra marketplace.profile: nada atiende un pedido del perfil", async () => {
    const { deps } = await contentJobSetup();
    const names = (marketplaceProfile: MarketplaceProfileJobDeps | null) =>
      buildJobs({
        importRun: {} as RunImportDeps,
        contentPrepare: deps,
        publicationPublish: {} as PublicationPublishJobDeps,
        publicationSync: {} as PublicationSyncJobDeps,
        tokensRefresh: {} as TokensRefreshJobDeps,
        marketplaceProfile,
        publicationDue: {} as PublicationDueJobDeps,
        publicationsWatch: {} as PublicationsWatchJobDeps,
        dbBackup: {} as DbBackupJobDeps,
      }).map((job) => job.name);

    expect(names(null)).not.toContain("marketplace.profile");
    // Lo demás (publicar a mano incluido: es de core, sin job) sigue registrado.
    expect(names(null)).toEqual(
      names({} as MarketplaceProfileJobDeps).filter((name) => name !== "marketplace.profile"),
    );
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

  it("auto_publish: tras una corrida con textos se pide con su aviso; un fallo no cambia la corrida y se registra solo con el código", async () => {
    const t = await contentJobSetup();
    const runId = await t.newRun();
    const listingId = (await t.contentRuns.get(runId))?.listingId;
    const asked: string[] = [];
    const autoPublish = {
      listings: {
        get: async (id: string) => {
          asked.push(id);
          throw new AppError("DB_UNAVAILABLE", "Avenida Secreta 123", { retriable: true });
        },
      },
    } as unknown as AutoPublishDeps;
    const { logger, lines } = captureLogger();

    await contentPrepareJob({ ...t.deps, autoPublish }).run(
      { contentRunId: runId },
      { ...context(false), logger },
    );

    expect(asked).toEqual([listingId]);
    expect(await t.contentRuns.get(runId)).toMatchObject({ status: "succeeded" });
    expect(lines.find((line) => line.code === "DB_UNAVAILABLE")).toMatchObject({ level: 40 });
    expect(JSON.stringify(lines)).not.toContain("Secreta");
  });

  it("auto_publish: un corredor sin auto_publish no publica ni registra nada; sin textos ni se pregunta", async () => {
    const t = await contentJobSetup();
    const runId = await t.newRun();
    const listingId = (await t.contentRuns.get(runId))?.listingId ?? "";
    const asked: string[] = [];
    const autoPublish = {
      listings: {
        get: async (id: string) => {
          asked.push(id);
          return { id, brokerId: "b", status: "ready" };
        },
      },
      brokers: { findById: async () => ({ id: "b", autoPublish: false }) },
    } as unknown as AutoPublishDeps;
    const { logger, lines } = captureLogger();

    await contentPrepareJob({ ...t.deps, autoPublish }).run(
      { contentRunId: runId },
      { ...context(false), logger },
    );
    const mediaOnly = (await t.contentRuns.create({ listingId, texts: false })).id;
    await contentPrepareJob({ ...t.deps, autoPublish }).run(
      { contentRunId: mediaOnly },
      { ...context(false), logger },
    );

    expect(asked).toEqual([listingId]);
    expect(JSON.stringify(lines)).not.toContain("auto_publish");
  });

  it("auto_publish: registra cada canal con su resultado, como aviso si alguno falló", async () => {
    const t = await contentJobSetup();
    const autoPublishWith = (channels: boolean) =>
      ({
        listings: { get: async (id: string) => ({ id, brokerId: "b", status: "ready" }) },
        brokers: { findById: async () => ({ id: "b", autoPublish: true }) },
        platformAccounts: {
          listByBroker: async () =>
            channels ? [{ id: "a", platform: "instagram", status: "connected" }] : [],
        },
        contents: {
          listCurrent: async () => [{ id: "c", platform: "instagram" }],
          // Aprobar lee el texto primero: aquí falla, con datos del aviso en el mensaje.
          get: async () => {
            throw new AppError("DB_UNAVAILABLE", "Avenida Secreta 123", { retriable: true });
          },
        },
      }) as unknown as AutoPublishDeps;
    const { logger, lines } = captureLogger();

    await contentPrepareJob({ ...t.deps, autoPublish: autoPublishWith(false) }).run(
      { contentRunId: await t.newRun() },
      { ...context(false), logger },
    );
    await contentPrepareJob({ ...t.deps, autoPublish: autoPublishWith(true) }).run(
      { contentRunId: await t.newRun() },
      { ...context(false), logger },
    );

    const logged = lines.filter((line) => String(line.msg).startsWith("auto_publish"));
    expect(logged).toMatchObject([
      { level: 30, channels: [] },
      {
        level: 40,
        channels: [{ platform: "instagram", result: "failed", code: "DB_UNAVAILABLE" }],
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain("Secreta");
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

  // F9-T05: una corrida de post en cola no es de `content.prepare`; tiene su propio barrido.
  it("una corrida de post en queued no se reencola como content.prepare, sino como post.draft", async () => {
    const repos = createInMemoryContentRepositories();
    const listingRun = await repos.contentRuns.create({ listingId: "l1", texts: true });
    const postRun = await repos.contentRuns.create({
      postId: "00000000-0000-4000-8000-000000000001",
      texts: true,
    });
    const runningPost = await repos.contentRuns.create({
      postId: "00000000-0000-4000-8000-000000000002",
      texts: true,
    });
    await repos.contentRuns.markRunning(runningPost.id);
    const queue = createInMemoryJobQueue();

    expect(await requeueQueuedContentRuns(repos.contentRuns, queue)).toEqual({
      requeued: 1,
      failed: [],
    });
    expect(await requeueQueuedPostRuns(repos.contentRuns, queue)).toEqual({
      requeued: 1,
      failed: [],
    });
    expect(queue.jobs).toEqual([
      {
        name: "content.prepare",
        data: { contentRunId: listingRun.id },
        options: { singletonKey: listingRun.id },
      },
      {
        name: "post.draft",
        data: { contentRunId: postRun.id },
        options: { singletonKey: postRun.id },
      },
    ]);
  });

  it("sin la cola de post.draft (antes de F9-T11), la corrida de post queda para el próximo arranque", async () => {
    const repos = createInMemoryContentRepositories();
    const postRun = await repos.contentRuns.create({
      postId: "00000000-0000-4000-8000-000000000001",
      texts: true,
    });
    const queue = createInMemoryJobQueue({
      fail: () =>
        new AppError("QUEUE_UNAVAILABLE", "La cola post.draft no existe", { retriable: true }),
    });

    expect(await requeueQueuedPostRuns(repos.contentRuns, queue)).toEqual({
      requeued: 0,
      failed: [postRun.id],
    });
    expect(await repos.contentRuns.get(postRun.id)).toMatchObject({ status: "queued" });
  });

  it("failAbandoned también cierra una corrida de post abandonada en running", async () => {
    const repos = createInMemoryContentRepositories();
    const postRun = await repos.contentRuns.create({
      postId: "00000000-0000-4000-8000-000000000001",
      texts: true,
    });
    await repos.contentRuns.markRunning(postRun.id);

    const closed = await failAbandonedContentRuns(
      repos.contentRuns,
      Date.now() + CONTENT_RUN_ABANDONED_AFTER_MS + 1000,
    );

    expect(closed).toEqual([postRun.id]);
    expect(await repos.contentRuns.get(postRun.id)).toMatchObject({
      status: "failed",
      error: { code: "CONTENT_RUN_ABANDONED" },
    });
  });
});

// F8-T12 (spec F8 §4.10): el arranque retoma un `auto_publish` cortado (las reglas, en core:
// `resume-auto-publish.test.ts`) y lo registra sin datos del aviso.
describe("auto_publish cortado · al arrancar", () => {
  it("una corrida que se cortó antes de resolver su auto_publish se retoma al arrancar", async () => {
    const t = await contentJobSetup();
    const runId = await t.newRun();
    // El worker se apagó justo antes de anotar el auto_publish.
    const contentRuns = {
      ...t.contentRuns,
      markAutoPublishDone: async () => {
        throw new Error("el worker se apagó aquí");
      },
    };
    await contentPrepareJob({ ...t.deps, shared: { ...t.deps.shared, contentRuns } }).run(
      { contentRunId: runId },
      context(false),
    );
    const listingId = (await t.contentRuns.get(runId))?.listingId;
    const asked: string[] = [];
    // Un doble parcial: el arranque solo lee la propiedad, el corredor y las publicaciones.
    const autoPublish = {
      listings: {
        get: async (id: string) => {
          asked.push(id);
          return { id, brokerId: "b", status: "ready" };
        },
      },
      brokers: { findById: async () => ({ id: "b", autoPublish: false }) },
      lock: {
        run: async (_id: string, fn: (locked: unknown) => Promise<unknown>) =>
          fn({ publications: { listByListing: async () => [] } }),
      },
    } as unknown as AutoPublishDeps;

    expect(
      await resumeAutoPublishAtStart({ ...autoPublish, contentRuns: t.contentRuns }, silentLogger),
    ).toBe(1);
    expect(asked).toEqual([listingId]);
    expect(
      await resumeAutoPublishAtStart({ ...autoPublish, contentRuns: t.contentRuns }, silentLogger),
    ).toBe(0);
  });
});
