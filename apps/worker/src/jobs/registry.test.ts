import { Writable } from "node:stream";
import { createLogger } from "@agentsales/config";
import { describe, expect, it } from "vitest";
import { type JobHandler, registerJobs, type WorkerBoss } from "./registry.js";

type Work = (jobs: { id: string; data: unknown }[]) => Promise<void>;

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

/** pg-boss simulado: guarda las colas creadas y los handlers registrados. */
function fakeBoss() {
  const queues: string[] = [];
  const workers = new Map<string, Work>();
  const boss: WorkerBoss = {
    createQueue: async (name) => {
      queues.push(name);
    },
    work: async (name, handler) => {
      workers.set(name, handler);
      return `worker-${name}`;
    },
  };
  return { boss, queues, workers };
}

describe("registerJobs", () => {
  it("crea la cola de cada job y registra su handler por nombre", async () => {
    const { boss, queues, workers } = fakeBoss();
    const { logger } = capture();
    const noop: JobHandler = async () => {};

    await registerJobs(boss, { "system.ping": noop, "media.process": noop }, logger);

    expect(queues).toEqual(["system.ping", "media.process"]);
    expect([...workers.keys()]).toEqual(["system.ping", "media.process"]);
  });

  it("pasa los datos y el id del job al handler y registra inicio y fin", async () => {
    const { boss, workers } = fakeBoss();
    const { logger, lines } = capture();
    const received: unknown[] = [];

    await registerJobs(
      boss,
      {
        "system.ping": async (data, { jobId }) => {
          received.push({ data, jobId });
        },
      },
      logger,
    );
    await workers.get("system.ping")?.([{ id: "j1", data: { message: "hola" } }]);

    expect(received).toEqual([{ data: { message: "hola" }, jobId: "j1" }]);
    expect(lines.map((line) => [line.msg, line.job, line.jobId])).toEqual([
      ["job iniciado", "system.ping", "j1"],
      ["job terminado", "system.ping", "j1"],
    ]);
  });

  it("propaga el error del handler para que pg-boss reintente, y lo registra", async () => {
    const { boss, workers } = fakeBoss();
    const { logger, lines } = capture();

    await registerJobs(
      boss,
      {
        "system.ping": async () => {
          throw new Error("falló el handler");
        },
      },
      logger,
    );

    await expect(workers.get("system.ping")?.([{ id: "j2", data: {} }])).rejects.toThrow(
      "falló el handler",
    );
    expect(lines.at(-1)).toMatchObject({ msg: "job falló", jobId: "j2", level: 50 });
  });
});
