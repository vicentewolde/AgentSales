import { AppError, JOB_PAYLOADS, type JobQueue } from "@agentsales/core";
import { createBoss } from "./boss.js";

/** Lo que el productor usa de pg-boss; `PgBoss` lo cumple. */
export type ProducerBoss = {
  start(): Promise<unknown>;
  send(
    name: string,
    data: object,
    options: { startAfter?: Date; singletonKey?: string },
  ): Promise<string | null>;
  stop(options: { graceful: boolean }): Promise<void>;
  on(event: "error", listener: (error: Error) => void): unknown;
};

export type JobQueueOptions = {
  /** Ver `BossOptions.connectionString`. */
  connectionString: string;
  /**
   * Errores de fondo de pg-boss (por ejemplo, el pool perdió la conexión). Sin un listener, un
   * evento `error` tumbaría el proceso; quien llama los registra (resumidos, como el worker).
   */
  onError?: (error: Error) => void;
  /** Solo para tests: reemplaza a pg-boss. */
  boss?: () => ProducerBoss;
};

export type PgBossJobQueue = JobQueue & {
  /** Cierra la conexión si se abrió. No falla. */
  stop(): Promise<void>;
};

/** "pg-boss is not installed" (esquema) o "Queue X does not exist" (cola): el worker nunca corrió. */
const NOT_READY = /not installed|requires migrations|does not exist/i;

function unavailable(error: unknown): AppError {
  const message = error instanceof Error ? error.message : String(error);
  return new AppError(
    "QUEUE_UNAVAILABLE",
    NOT_READY.test(message)
      ? "La cola no está lista: arranca el worker una vez (pnpm dev) y vuelve a intentar"
      : "No se pudo conectar a la cola",
    { retriable: true, cause: error },
  );
}

/**
 * `JobQueue` sobre pg-boss en rol `producer` (spec F1 §4.1, D2). Arranca pg-boss **recién en el
 * primer `enqueue`**: la API levanta aunque el esquema `pgboss` no exista todavía. Si el arranque
 * falla, el siguiente `enqueue` lo vuelve a intentar.
 *
 * No crea colas: las crea el worker con su política al arrancar, así que encolar antes de que el
 * worker haya corrido alguna vez da `QUEUE_UNAVAILABLE`.
 */
export function createJobQueue(options: JobQueueOptions): PgBossJobQueue {
  const makeBoss =
    options.boss ??
    (() => createBoss({ connectionString: options.connectionString, role: "producer" }));
  let starting: Promise<ProducerBoss> | null = null;

  function started(): Promise<ProducerBoss> {
    starting ??= (async () => {
      const boss = makeBoss();
      boss.on("error", (error) => options.onError?.(error));
      try {
        await boss.start();
        return boss;
      } catch (error) {
        await boss.stop({ graceful: false }).catch(() => undefined);
        throw error;
      }
    })().catch((error: unknown) => {
      // Un arranque fallido no queda guardado: el próximo `enqueue` reintenta.
      starting = null;
      throw unavailable(error);
    });
    return starting;
  }

  return {
    async enqueue(name, data, enqueueOptions = {}) {
      // Los datos se validan antes de conectar: un payload inválido es un bug, no una caída.
      const parsed = JOB_PAYLOADS[name].safeParse(data);
      if (!parsed.success) {
        throw new AppError("JOB_PAYLOAD_INVALID", `Datos inválidos para el job ${name}`, {
          details: {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        });
      }
      const boss = await started();
      try {
        return await boss.send(name, parsed.data, {
          ...(enqueueOptions.startAfter === undefined
            ? {}
            : { startAfter: enqueueOptions.startAfter }),
          ...(enqueueOptions.singletonKey === undefined
            ? {}
            : { singletonKey: enqueueOptions.singletonKey }),
        });
      } catch (error) {
        throw unavailable(error);
      }
    },

    async stop() {
      const current = starting;
      starting = null;
      if (current === null) return;
      const boss = await current.catch(() => null);
      await boss?.stop({ graceful: false }).catch(() => undefined);
    },
  };
}
