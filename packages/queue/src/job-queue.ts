import {
  AppError,
  type EnqueueOptions,
  JOB_PAYLOADS,
  type JobName,
  type JobPayload,
  type JobQueue,
} from "@agentsales/core";
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
  on(event: "error", listener: (error: unknown) => void): unknown;
};

export type JobQueueOptions = {
  /** Ver `BossOptions.connectionString`. */
  connectionString: string;
  /**
   * Errores de fondo de pg-boss (por ejemplo, el pool perdió la conexión). Sin un listener, un
   * evento `error` tumbaría el proceso; quien llama los registra (resumidos, como el worker).
   */
  onError?: (error: unknown) => void;
  /** Solo para tests: reemplaza a pg-boss. */
  boss?: () => ProducerBoss;
};

export type PgBossJobQueue = JobQueue & {
  /**
   * Cierra la conexión si se abrió (también si el arranque está en curso). No falla. Después,
   * `enqueue` da `QUEUE_UNAVAILABLE`.
   */
  stop(): Promise<void>;
};

/**
 * Mensajes exactos de pg-boss cuando el worker nunca corrió: sin esquema, esquema viejo o cola sin
 * crear. Anclados, para no confundirlos con `database "x" does not exist` de un `DATABASE_URL` mal
 * puesto, que es "no se pudo conectar".
 */
const NOT_READY =
  /^(pg-boss is not installed|pg-boss database requires migrations|Queue \S+ does not exist)/;

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

/** Valida los datos con `JOB_PAYLOADS`: un payload inválido es un bug, no una caída. */
function payloadOf<N extends JobName>(name: N, data: JobPayload<N>): JobPayload<N> {
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
  // zod no estrecha `JOB_PAYLOADS[name]` por `N`: el esquema es justamente el de `N`.
  return parsed.data as JobPayload<N>;
}

/** Envía un job ya validado; cualquier falla de pg-boss es `QUEUE_UNAVAILABLE`. */
async function send(
  boss: Pick<ProducerBoss, "send">,
  name: JobName,
  data: object,
  options: EnqueueOptions,
): Promise<string | null> {
  try {
    return await boss.send(name, data, {
      ...(options.startAfter === undefined ? {} : { startAfter: options.startAfter }),
      ...(options.singletonKey === undefined ? {} : { singletonKey: options.singletonKey }),
    });
  } catch (error) {
    throw unavailable(error);
  }
}

/**
 * `JobQueue` sobre un pg-boss **ya arrancado** que no es suyo: el worker reencola al arrancar con su
 * propia conexión, sin abrir otra como `createJobQueue`. Valida y traduce los errores igual; no
 * arranca ni detiene pg-boss (eso lo hace el worker).
 */
export function jobQueueFromBoss(boss: Pick<ProducerBoss, "send">): JobQueue {
  return {
    async enqueue(name, data, enqueueOptions = {}) {
      return send(boss, name, payloadOf(name, data), enqueueOptions);
    },
  };
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
  let stopped = false;

  function started(): Promise<ProducerBoss> {
    if (starting !== null) return starting;
    const attempt: Promise<ProducerBoss> = (async () => {
      const boss = makeBoss();
      // Antes de `start`: sin un listener, un evento `error` de fondo tumbaría el proceso.
      boss.on("error", (error) => options.onError?.(error));
      try {
        await boss.start();
        return boss;
      } catch (error) {
        await boss.stop({ graceful: false }).catch(() => undefined);
        throw error;
      }
    })().catch((error: unknown) => {
      // Un arranque fallido no queda guardado: el próximo `enqueue` reintenta. Solo se limpia si
      // sigue siendo el arranque vigente (un `stop` o un arranque nuevo pudieron reemplazarlo).
      if (starting === attempt) starting = null;
      throw unavailable(error);
    });
    starting = attempt;
    return attempt;
  }

  return {
    async enqueue(name, data, enqueueOptions = {}) {
      // Los datos se validan antes de conectar.
      const payload = payloadOf(name, data);
      // Tras `stop` (apagado de la API), un `enqueue` rezagado no reabre la conexión.
      if (stopped) {
        throw new AppError("QUEUE_UNAVAILABLE", "La cola se cerró: el proceso se está apagando", {
          retriable: true,
        });
      }
      return send(await started(), name, payload, enqueueOptions);
    },

    async stop() {
      stopped = true;
      const current = starting;
      starting = null;
      if (current === null) return;
      const boss = await current.catch(() => null);
      await boss?.stop({ graceful: false }).catch(() => undefined);
    },
  };
}
