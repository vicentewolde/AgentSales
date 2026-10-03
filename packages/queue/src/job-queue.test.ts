import { isAppError } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { createJobQueue, jobQueueFromBoss, type ProducerBoss } from "./job-queue.js";

const RUN_ID = "7f1c2a4e-9b3d-4f6a-8c2e-1d5b9a7e3f10";

type FakeOptions = {
  /** Error de `start` en los primeros N arranques. */
  failStarts?: number;
  /** `start` espera a esta promesa (para probar un arranque en curso). */
  startGate?: Promise<void>;
  startError?: string;
  sendError?: string;
  sendResult?: string | null;
};

/** pg-boss simulado: cuenta arranques y paradas y guarda lo enviado. */
function fakeBosses(options: FakeOptions = {}) {
  const sent: { name: string; data: object; options: object }[] = [];
  const stats = { created: 0, starts: 0, stops: 0, errorListeners: 0 };
  const listeners: ((error: unknown) => void)[] = [];
  const make = (): ProducerBoss => {
    stats.created += 1;
    return {
      async start() {
        stats.starts += 1;
        await options.startGate;
        if (stats.starts <= (options.failStarts ?? 0)) {
          throw new Error(options.startError ?? "connect ECONNREFUSED 127.0.0.1:5432");
        }
      },
      async send(name, data, sendOptions) {
        if (options.sendError !== undefined) throw new Error(options.sendError);
        sent.push({ name, data, options: sendOptions });
        return options.sendResult === undefined ? "job-1" : options.sendResult;
      },
      async stop() {
        stats.stops += 1;
      },
      on(_event, listener) {
        stats.errorListeners += 1;
        listeners.push(listener);
      },
    };
  };
  /** Simula un error de fondo de pg-boss (por ejemplo, el pool perdió la conexión). */
  const emitError = (error: unknown) => {
    for (const listener of listeners) listener(error);
  };
  return { make, sent, stats, emitError };
}

const queueWith = (fake: ReturnType<typeof fakeBosses>) =>
  createJobQueue({ connectionString: "postgres://no-se-usa", boss: fake.make });

async function caught(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("createJobQueue", () => {
  it("no arranca pg-boss hasta el primer enqueue, y arranca una sola vez", async () => {
    const fake = fakeBosses();
    const queue = queueWith(fake);
    expect(fake.stats.created).toBe(0);

    await Promise.all([
      queue.enqueue("import.run", { importRunId: RUN_ID }),
      queue.enqueue("system.ping", { delayMs: 0 }),
    ]);

    expect(fake.stats).toMatchObject({ created: 1, starts: 1, errorListeners: 1 });
    expect(fake.sent.map((job) => job.name)).toEqual(["import.run", "system.ping"]);
  });

  it("manda los datos validados y las opciones; null si ya había uno con el mismo singletonKey", async () => {
    const fake = fakeBosses({ sendResult: null });
    const startAfter = new Date("2026-10-02T12:00:00Z");

    const jobId = await queueWith(fake).enqueue(
      "import.run",
      { importRunId: RUN_ID, extra: "se descarta" } as { importRunId: string },
      { singletonKey: RUN_ID, startAfter },
    );

    expect(jobId).toBeNull();
    expect(fake.sent).toEqual([
      {
        name: "import.run",
        data: { importRunId: RUN_ID },
        options: { singletonKey: RUN_ID, startAfter },
      },
    ]);
  });

  it("datos inválidos → JOB_PAYLOAD_INVALID, sin conectar", async () => {
    const fake = fakeBosses();

    const error = await caught(queueWith(fake).enqueue("import.run", { importRunId: "no-uuid" }));

    expect(isAppError(error) && [error.code, error.retriable]).toEqual([
      "JOB_PAYLOAD_INVALID",
      false,
    ]);
    expect(fake.stats.created).toBe(0);
  });

  it.each([
    [
      "el esquema no existe",
      { failStarts: 1, startError: "pg-boss is not installed" },
      "no está lista",
    ],
    ["no hay conexión", { failStarts: 1 }, "No se pudo conectar"],
    ["la cola no existe", { sendError: "Queue import.run does not exist" }, "no está lista"],
  ] as const)("si %s → QUEUE_UNAVAILABLE, reintentable", async (_, options, message) => {
    const error = await caught(
      queueWith(fakeBosses(options)).enqueue("import.run", { importRunId: RUN_ID }),
    );

    expect(isAppError(error) && [error.code, error.retriable]).toEqual(["QUEUE_UNAVAILABLE", true]);
    expect(isAppError(error) && error.message).toContain(message);
  });

  it("un arranque fallido se cierra y el siguiente enqueue lo reintenta", async () => {
    const fake = fakeBosses({ failStarts: 1 });
    const queue = queueWith(fake);

    await caught(queue.enqueue("import.run", { importRunId: RUN_ID }));
    expect(fake.stats).toMatchObject({ created: 1, starts: 1, stops: 1 });

    expect(await queue.enqueue("import.run", { importRunId: RUN_ID })).toBe("job-1");
    expect(fake.stats).toMatchObject({ created: 2, starts: 2 });
  });

  it("dos enqueue con el arranque fallando comparten un solo intento y fallan los dos", async () => {
    const fake = fakeBosses({ failStarts: 1 });
    const queue = queueWith(fake);

    const errors = await Promise.all([
      caught(queue.enqueue("system.ping", {})),
      caught(queue.enqueue("system.ping", {})),
    ]);

    expect(errors.map((error) => isAppError(error) && error.code)).toEqual([
      "QUEUE_UNAVAILABLE",
      "QUEUE_UNAVAILABLE",
    ]);
    expect(fake.stats.starts).toBe(1);
  });

  it("un database inexistente (DATABASE_URL mal puesto) no se confunde con 'arranca el worker'", async () => {
    const error = await caught(
      queueWith(
        fakeBosses({ failStarts: 1, startError: 'database "otra" does not exist' }),
      ).enqueue("system.ping", {}),
    );
    expect(isAppError(error) && error.message).toContain("No se pudo conectar");
  });

  it("sin startAfter ni singletonKey, no manda esas claves", async () => {
    const fake = fakeBosses();
    await queueWith(fake).enqueue("system.ping", {});
    expect(fake.sent[0]?.options).toEqual({});
  });

  it("los errores de fondo de pg-boss van a onError; sin onError no rompen nada", async () => {
    const seen: unknown[] = [];
    const fake = fakeBosses();
    await createJobQueue({
      connectionString: "postgres://no-se-usa",
      boss: fake.make,
      onError: (error) => seen.push(error),
    }).enqueue("system.ping", {});
    fake.emitError({ message: "Connection terminated unexpectedly" });
    expect(seen).toEqual([{ message: "Connection terminated unexpectedly" }]);

    const silent = fakeBosses();
    await queueWith(silent).enqueue("system.ping", {});
    expect(() => silent.emitError(new Error("sin listener propio"))).not.toThrow();
  });

  it("stop con el arranque en curso cierra esa conexión, y después enqueue no reabre", async () => {
    let open = () => {};
    const fake = fakeBosses({ startGate: new Promise<void>((resolve) => (open = resolve)) });
    const queue = queueWith(fake);
    const pending = queue.enqueue("system.ping", {});

    const stopping = queue.stop();
    open();
    await Promise.all([stopping, pending.catch(() => undefined)]);

    expect(fake.stats.stops).toBe(1);
    const error = await caught(queue.enqueue("system.ping", {}));
    expect(isAppError(error) && [error.code, error.message]).toEqual([
      "QUEUE_UNAVAILABLE",
      "La cola se cerró: el proceso se está apagando",
    ]);
    expect(fake.stats.created).toBe(1);
  });

  it("stop cierra la conexión si se abrió, y no hace nada si no", async () => {
    const unused = fakeBosses();
    await queueWith(unused).stop();
    expect(unused.stats).toMatchObject({ created: 0, stops: 0 });

    const fake = fakeBosses();
    const queue = queueWith(fake);
    await queue.enqueue("system.ping", {});
    await queue.stop();
    expect(fake.stats.stops).toBe(1);
  });
});

describe("jobQueueFromBoss", () => {
  it("encola con el pg-boss del worker, sin arrancarlo ni detenerlo", async () => {
    const fake = fakeBosses({ sendResult: null });
    const boss = fake.make();
    const queue = jobQueueFromBoss(boss);

    const id = await queue.enqueue(
      "content.prepare",
      { contentRunId: RUN_ID },
      { singletonKey: RUN_ID },
    );

    expect(id).toBeNull(); // ya había uno con la misma clave
    expect(fake.sent).toEqual([
      {
        name: "content.prepare",
        data: { contentRunId: RUN_ID },
        options: { singletonKey: RUN_ID },
      },
    ]);
    expect(fake.stats).toMatchObject({ starts: 0, stops: 0 });
  });

  it("valida los datos (JOB_PAYLOAD_INVALID) y traduce las fallas a QUEUE_UNAVAILABLE", async () => {
    const invalid = fakeBosses();
    const bad = await caught(
      jobQueueFromBoss(invalid.make()).enqueue("content.prepare", { contentRunId: "x" }),
    );
    expect(bad).toMatchObject({ code: "JOB_PAYLOAD_INVALID" });
    expect(invalid.sent).toEqual([]);

    const down = fakeBosses({ sendError: "Connection terminated unexpectedly" });
    const error = await caught(
      jobQueueFromBoss(down.make()).enqueue("content.prepare", { contentRunId: RUN_ID }),
    );
    expect(isAppError(error) && error.code === "QUEUE_UNAVAILABLE" && error.retriable).toBe(true);
  });
});
