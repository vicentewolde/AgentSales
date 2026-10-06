import { Writable } from "node:stream";
import { createLogger } from "@agentsales/config";
import { AppError } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import type { Job, QueuePolicy } from "./define.js";
import { registerJobs, type WorkerBoss } from "./registry.js";

type Batch = { id: string; data: unknown; retryCount: number; retryLimit: number }[];
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
function fakeBoss(options: { failCreate?: boolean; policies?: Record<string, string> } = {}) {
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
    getQueue: async (name) => ({ policy: options.policies?.[name] ?? "standard" }),
    work: async (name, workOptions, handler) => {
      calls.push(`work ${name} ${JSON.stringify(workOptions)}`);
      workers.set(name, handler);
      return `worker-${name}`;
    },
    schedule: async (name, cron, data, scheduleOptions) => {
      calls.push(
        `schedule ${name} ${cron} ${JSON.stringify(data)} ${JSON.stringify(scheduleOptions)}`,
      );
    },
  };
  return { boss, calls, workers };
}

const job = (name: Job["name"], run: Job["run"] = async () => {}): Job => ({
  name,
  queue: policy,
  run,
});

describe("registerJobs", () => {
  it("crea y actualiza cada cola con su política y registra un worker de a un job", async () => {
    const { boss, calls } = fakeBoss();
    const { logger } = capture();

    const done = await registerJobs(boss, [job("system.ping"), job("import.run")], logger);

    expect(done).toBe(true);
    expect(calls).toEqual([
      `create system.ping ${JSON.stringify(policy)}`,
      "update system.ping",
      'work system.ping {"batchSize":1,"includeMetadata":true}',
      `create import.run ${JSON.stringify(policy)}`,
      "update import.run",
      'work import.run {"batchSize":1,"includeMetadata":true}',
    ]);
  });

  it("programa el cron de un job después de crear su cola y registrar su worker", async () => {
    const { boss, calls } = fakeBoss();
    const { logger } = capture();
    const scheduled: Job = {
      ...job("tokens.refresh"),
      schedule: {
        cron: "0 12 * * *",
        tz: "America/Santiago",
        data: {},
        singletonKey: "tokens.refresh",
      },
    };

    await registerJobs(boss, [job("system.ping"), scheduled], logger);

    expect(calls.slice(3)).toEqual([
      `create tokens.refresh ${JSON.stringify(policy)}`,
      "update tokens.refresh",
      'work tokens.refresh {"batchSize":1,"includeMetadata":true}',
      'schedule tokens.refresh 0 12 * * * {} {"tz":"America/Santiago","singletonKey":"tokens.refresh"}',
    ]);
    expect(calls.filter((call) => call.startsWith("schedule"))).toHaveLength(1);
  });

  it("la política de pg-boss (policy) va solo al crear la cola, no al actualizarla", async () => {
    const updates: unknown[] = [];
    const { boss, calls } = fakeBoss();
    boss.updateQueue = async (_name, options) => void updates.push(options);
    const { logger } = capture();
    const exclusive = { ...policy, policy: "exclusive" as const };

    await registerJobs(
      boss,
      [{ name: "import.run", queue: exclusive, run: async () => {} }],
      logger,
    );

    expect(calls[0]).toBe(`create import.run ${JSON.stringify(exclusive)}`);
    expect(updates).toEqual([policy]);
  });

  it("avisa si la cola ya existía con otra política (no se puede cambiar sin borrarla)", async () => {
    const { boss } = fakeBoss({ policies: { "import.run": "standard" } });
    const { logger, lines } = capture();

    await registerJobs(
      boss,
      [{ name: "import.run", queue: { ...policy, policy: "exclusive" }, run: async () => {} }],
      logger,
    );

    expect(lines).toContainEqual(
      expect.objectContaining({
        job: "import.run",
        expected: "exclusive",
        actual: "standard",
        level: 50,
      }),
    );
  });

  it.each([
    [0, 2, false],
    [1, 2, false],
    [2, 2, true],
  ])(
    "con retryCount %i de %i, isLastAttempt es %s (y el job recibe el retryCount)",
    async (retryCount, retryLimit, last) => {
      const { boss, workers } = fakeBoss();
      const { logger } = capture();
      const seen: [boolean, number][] = [];

      await registerJobs(
        boss,
        [
          job("import.run", async (_data, context) => {
            seen.push([context.isLastAttempt, context.retryCount]);
          }),
        ],
        logger,
      );
      await workers.get("import.run")?.([{ id: "j9", data: {}, retryCount, retryLimit }]);

      expect(seen).toEqual([[last, retryCount]]);
    },
  );

  it("pasa los datos y el id del job, y registra inicio y fin", async () => {
    const { boss, workers } = fakeBoss();
    const { logger, lines } = capture();
    const received: unknown[] = [];

    await registerJobs(
      boss,
      [job("system.ping", async (data, { jobId }) => void received.push({ data, jobId }))],
      logger,
    );
    await workers.get("system.ping")?.([
      { id: "j1", data: { message: "hola" }, retryCount: 0, retryLimit: 3 },
    ]);

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

    await expect(
      workers.get("system.ping")?.([{ id: "j2", data: {}, retryCount: 0, retryLimit: 3 }]),
    ).rejects.toThrow("R2 no respondió");
    expect(lines.at(-1)).toMatchObject({ jobId: "j2", level: 50 });
  });

  it("un error no reintentable se registra y no se relanza", async () => {
    const { boss, workers } = fakeBoss();
    const { logger, lines } = capture();

    await registerJobs(
      boss,
      [
        job("import.run", async () => {
          throw new AppError("INVALID_TRANSITION", "Transición inválida de draft a published");
        }),
      ],
      logger,
    );

    await expect(
      workers.get("import.run")?.([{ id: "j3", data: {}, retryCount: 0, retryLimit: 3 }]),
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

    const done = await registerJobs(trackingBoss, [job("system.ping"), job("import.run")], logger, {
      isStopping: () => stopping,
    });

    expect(done).toBe(false);
    expect(calls.filter((call) => call.startsWith("work"))).toEqual([
      'work system.ping {"batchSize":1,"includeMetadata":true}',
    ]);
  });

  it("propaga el fallo al crear una cola", async () => {
    const { boss } = fakeBoss({ failCreate: true });
    const { logger } = capture();

    await expect(registerJobs(boss, [job("system.ping")], logger)).rejects.toThrow("sin conexión");
  });
});
