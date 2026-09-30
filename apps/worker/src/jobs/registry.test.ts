import { Writable } from "node:stream";
import { createLogger } from "@agentsales/config";
import { AppError } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import type { Job, QueuePolicy } from "./define.js";
import { registerJobs, type WorkerBoss } from "./registry.js";

type Batch = { id: string; data: unknown }[];
type Work = (jobs: Batch) => Promise<void>;

const policy: QueuePolicy = {
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 600,
};

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(
    { level: "info" },
    new Writable({
      write(chunk, _encoding, callback) {
        lines.push(JSON.parse(chunk.toString()));
        callback();
      },
    }),
  );
  return { logger, lines };
}

/** pg-boss simulado: guarda las llamadas y los handlers registrados. */
function fakeBoss(options: { failCreate?: boolean } = {}) {
  const calls: string[] = [];
  const workers = new Map<string, Work>();
  const boss: WorkerBoss = {
    createQueue: async (name, queue) => {
      if (options.failCreate) {
        throw new Error("sin conexión");
      }
      calls.push(`create ${name} ${JSON.stringify(queue)}`);
    },
    updateQueue: async (name) => {
      calls.push(`update ${name}`);
    },
    work: async (name, workOptions, handler) => {
      calls.push(`work ${name} ${JSON.stringify(workOptions)}`);
      workers.set(name, handler);
      return `worker-${name}`;
    },
  };
  return { boss, calls, workers };
}

const job = (name: string, run: Job["run"] = async () => {}): Job => ({ name, queue: policy, run });

describe("registerJobs", () => {
  it("crea y actualiza cada cola con su política y registra un worker de a un job", async () => {
    const { boss, calls } = fakeBoss();
    const { logger } = capture();

    const done = await registerJobs(boss, [job("system.ping"), job("media.process")], logger);

    expect(done).toBe(true);
    expect(calls).toEqual([
      `create system.ping ${JSON.stringify(policy)}`,
      "update system.ping",
      'work system.ping {"batchSize":1}',
      `create media.process ${JSON.stringify(policy)}`,
      "update media.process",
      'work media.process {"batchSize":1}',
    ]);
  });

  it("pasa los datos y el id del job, y registra inicio y fin", async () => {
    const { boss, workers } = fakeBoss();
    const { logger, lines } = capture();
    const received: unknown[] = [];

    await registerJobs(
      boss,
      [job("system.ping", async (data, { jobId }) => void received.push({ data, jobId }))],
      logger,
    );
    await workers.get("system.ping")?.([{ id: "j1", data: { message: "hola" } }]);

    expect(received).toEqual([{ data: { message: "hola" }, jobId: "j1" }]);
    expect(lines.map((line) => [line.msg, line.job, line.jobId])).toEqual([
      ["job iniciado", "system.ping", "j1"],
      ["job terminado", "system.ping", "j1"],
    ]);
  });

  it("propaga un error reintentable para que pg-boss reintente", async () => {
    const { boss, workers } = fakeBoss();
    const { logger, lines } = capture();

    await registerJobs(
      boss,
      [
        job("system.ping", async () => {
          throw new AppError("STORAGE_UNAVAILABLE", "R2 no respondió", { retriable: true });
        }),
      ],
      logger,
    );

    await expect(workers.get("system.ping")?.([{ id: "j2", data: {} }])).rejects.toThrow(
      "R2 no respondió",
    );
    expect(lines.at(-1)).toMatchObject({ jobId: "j2", level: 50 });
  });

  it("un error no reintentable se registra y no se relanza", async () => {
    const { boss, workers } = fakeBoss();
    const { logger, lines } = capture();

    await registerJobs(
      boss,
      [
        job("publication.publish", async () => {
          throw new AppError("INVALID_TRANSITION", "Transición inválida de draft a published");
        }),
      ],
      logger,
    );

    await expect(
      workers.get("publication.publish")?.([{ id: "j3", data: {} }]),
    ).resolves.toBeUndefined();
    expect(lines.at(-1)).toMatchObject({
      msg: "job falló sin reintento (error no reintentable)",
      jobId: "j3",
    });
  });

  it("deja de registrar si el worker se apaga durante el arranque", async () => {
    const { boss, calls } = fakeBoss();
    const { logger } = capture();
    let stopping = false;
    const trackingBoss: WorkerBoss = {
      ...boss,
      work: async (...args) => {
        stopping = true;
        return boss.work(...args);
      },
    };

    const done = await registerJobs(
      trackingBoss,
      [job("system.ping"), job("media.process")],
      logger,
      { isStopping: () => stopping },
    );

    expect(done).toBe(false);
    expect(calls.filter((call) => call.startsWith("work"))).toEqual([
      'work system.ping {"batchSize":1}',
    ]);
  });

  it("propaga el fallo al crear una cola", async () => {
    const { boss } = fakeBoss({ failCreate: true });
    const { logger } = capture();

    await expect(registerJobs(boss, [job("system.ping")], logger)).rejects.toThrow("sin conexión");
  });
});
