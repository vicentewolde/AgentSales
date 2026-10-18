import { AppError, type Publication, SESSION_IDLE_MS, STALE_PUBLISHING_MS } from "@agentsales/core";
import {
  createInMemoryImportRunRepository,
  createInMemoryMediaStorage,
  createPublicationScenario,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { captureLogger } from "../../test/content-fixture.js";
import {
  PUBLICATIONS_WATCH_KEY,
  PUBLICATIONS_WATCH_QUEUE,
  PUBLICATIONS_WATCH_SCHEDULE,
  publicationsWatchJob,
} from "./publications-watch.js";
import { registerJobs, type WorkerBoss } from "./registry.js";

/** Un pg-boss falso: guarda el handler, la cola creada y el cron. */
function fakeBoss() {
  const bossCalls: { name: string; args: unknown[] }[] = [];
  let work: Parameters<WorkerBoss["work"]>[2] | undefined;
  const boss: WorkerBoss = {
    createQueue: async (...args) => {
      bossCalls.push({ name: "createQueue", args });
    },
    updateQueue: async () => {},
    getQueue: async () => ({ policy: "exclusive" }),
    work: async (_name, _options, handler) => {
      work = handler;
      return "w1";
    },
    schedule: async (...args) => {
      bossCalls.push({ name: "schedule", args });
    },
  };
  const run = () => work?.([{ id: "job-1", data: {}, retryCount: 0, retryLimit: 1 }]);
  return { boss, bossCalls, run };
}

async function setup() {
  const t = await createPublicationScenario();
  const { logger, lines } = captureLogger();
  const boss = fakeBoss();
  const job = publicationsWatchJob({
    publications: t.publications,
    platformAccounts: t.platformAccounts,
    queue: t.queue,
    now: () => new Date(Date.now() + STALE_PUBLISHING_MS + 60_000),
  });
  await registerJobs(boss.boss, [job], logger);
  return { t, lines, ...boss };
}

describe("publications.watch", () => {
  it("la cola es exclusive con clave fija y el cron corre cada hora en hora de Chile", async () => {
    const { bossCalls } = await setup();

    expect(PUBLICATIONS_WATCH_QUEUE).toEqual({
      policy: "exclusive",
      retryLimit: 1,
      retryDelay: 60,
      retryBackoff: false,
      expireInSeconds: 300,
    });
    expect(bossCalls).toEqual([
      { name: "createQueue", args: ["publications.watch", PUBLICATIONS_WATCH_QUEUE] },
      {
        name: "schedule",
        args: [
          "publications.watch",
          "0 * * * *",
          {},
          { tz: "America/Santiago", missed: "skip", singletonKey: PUBLICATIONS_WATCH_KEY },
        ],
      },
    ]);
    expect(PUBLICATIONS_WATCH_SCHEDULE.singletonKey).toBe(PUBLICATIONS_WATCH_KEY);
  });

  it("reencola una atascada y lo registra con su id", async () => {
    const { t, lines, run } = await setup();
    const post = t.byFormat("post") as Publication;
    await t.publications.transition(
      post.id,
      { from: "approved", to: "publishing", changes: { dryRun: true } },
      { actor: "operator" },
    );

    await run();

    expect(t.queue.jobs.map((job) => job.data)).toEqual([{ publicationId: post.id }]);
    expect(
      lines.find(
        (line) => line.msg === "vigilancia: publicaciones atascadas en publicando, reencoladas",
      ),
    ).toMatchObject({ level: 40, publicationIds: [post.id] });
  });

  it("borra las sesiones y los state de OAuth vencidos, y si falla solo lo advierte (F7)", async () => {
    const t = await createPublicationScenario();
    const { logger, lines } = captureLogger();
    const boss = fakeBoss();
    const now = new Date("2026-10-17T15:00:00.000Z");
    const calls: unknown[] = [];
    let fail = false;
    const job = publicationsWatchJob({
      publications: t.publications,
      platformAccounts: t.platformAccounts,
      queue: t.queue,
      now: () => now,
      authCleanup: {
        sessions: {
          deleteExpired: async (query) => {
            calls.push(query);
            if (fail) throw new AppError("DB_UNAVAILABLE", "sin base", { retriable: true });
            return 2;
          },
        },
        oauthStates: { deleteExpired: async () => 1 },
      },
    });
    await registerJobs(boss.boss, [job], logger);

    await boss.run();
    expect(calls).toEqual([{ now, idleBefore: new Date(now.getTime() - SESSION_IDLE_MS) }]);
    expect(
      lines.find(
        (line) => line.msg === "vigilancia: sesiones y estados de OAuth vencidos borrados",
      ),
    ).toMatchObject({ level: 30, sessions: 2, oauthStates: 1 });

    fail = true;
    await boss.run();
    expect(
      lines.find((line) => line.msg === "vigilancia: no se pudieron borrar las sesiones vencidas"),
    ).toMatchObject({ level: 40, code: "DB_UNAVAILABLE" });
  });

  it("cierra las cargas sin terminar de subir y borra sus archivos de R2; si falla solo lo advierte (F8)", async () => {
    const t = await createPublicationScenario();
    const { logger, lines } = captureLogger();
    const boss = fakeBoss();
    const created = new Date("2026-10-17T12:00:00.000Z");
    const importRuns = createInMemoryImportRunRepository({
      nextId: () => "7f1c2a4e-9b3d-4f6a-8c2e-1d5b9a7e3f10",
      now: () => created,
    });
    const storage = createInMemoryMediaStorage();
    const run = await importRuns.create({
      status: "awaiting_upload",
      source: "xlsx",
      fileName: "p.xlsx",
      dryRun: false,
      input: {
        broker: null,
        dryRun: false,
        xlsx: { key: "imports/x/xlsx/p.xlsx", name: "p.xlsx", size: 1, sha256: "a".repeat(64) },
        media: null,
      },
    });
    await storage.put(`imports/${run.id}/xlsx/p.xlsx`, new Uint8Array([1]), "x");
    let failList = false;
    const list = storage.list.bind(storage);
    storage.list = async (prefix) => {
      if (failList)
        throw new AppError("STORAGE_UNAVAILABLE", "R2 no respondió", { retriable: true });
      return list(prefix);
    };
    const job = publicationsWatchJob({
      publications: t.publications,
      platformAccounts: t.platformAccounts,
      queue: t.queue,
      now: () => new Date(created.getTime() + 25 * 60 * 60 * 1000),
      importCleanup: { importRuns, storage },
    });
    await registerJobs(boss.boss, [job], logger);

    await boss.run();

    expect(await importRuns.get(run.id)).toMatchObject({
      status: "failed",
      error: { code: "IMPORT_UPLOAD_ABANDONED" },
    });
    expect(await list("imports/")).toEqual([]);
    expect(
      lines.find((line) => line.msg === "vigilancia: cargas sin terminar de subir cerradas"),
    ).toMatchObject({ level: 40, importRunIds: [run.id] });

    failList = true;
    await boss.run();
    expect(
      lines.find((line) => line.msg === "vigilancia: no se pudieron limpiar las subidas"),
    ).toMatchObject({ level: 40, code: "STORAGE_UNAVAILABLE" });
  });
});
