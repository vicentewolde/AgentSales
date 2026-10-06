import type { Logger } from "@agentsales/config";
import { isAppError } from "@agentsales/core";
import type { Job, QueuePolicy } from "./define.js";

/** Lo que el registro usa de pg-boss; `PgBoss` lo cumple. */
export type WorkerBoss = {
  createQueue(name: string, options: QueuePolicy): Promise<void>;
  updateQueue(name: string, options: Omit<QueuePolicy, "policy">): Promise<void>;
  getQueue(name: string): Promise<{ policy?: string } | null>;
  schedule(
    name: string,
    cron: string,
    data: object,
    options: { tz: string; missed: "skip"; singletonKey?: string },
  ): Promise<void>;
  work(
    name: string,
    options: { batchSize: 1; includeMetadata: true },
    handler: (
      jobs: { id: string; data: unknown; retryCount: number; retryLimit: number }[],
    ) => Promise<void>,
  ): Promise<string>;
};

export type RegisterOptions = {
  /** Si el worker se está apagando, se deja de registrar (una señal durante el arranque). */
  isStopping?: () => boolean;
};

/**
 * Crea o actualiza la cola de cada job con su política, registra su handler y, si tiene cron, lo
 * programa (`schedule` exige que la cola exista).
 * - `batchSize: 1`: si un lote trae varios jobs y falla uno, pg-boss reintenta el lote completo.
 * - Un `AppError` no reintentable (datos inválidos, transición inválida…) se registra y el job se
 *   da por cerrado: reintentarlo no cambiaría el resultado. El caso de uso ya dejó el estado de
 *   dominio (p. ej. la publicación en `failed`). Cualquier otro error se propaga y pg-boss reintenta.
 *
 * Devuelve `false` si se interrumpió porque el worker se está apagando.
 */
export async function registerJobs(
  boss: WorkerBoss,
  jobs: readonly Job[],
  logger: Logger,
  { isStopping = () => false }: RegisterOptions = {},
): Promise<boolean> {
  for (const job of jobs) {
    if (isStopping()) {
      return false;
    }
    // La política (`policy`) solo al crear: pg-boss no deja cambiarla y `updateQueue` falla con ella.
    const { policy: _policy, ...updatable } = job.queue;
    await boss.createQueue(job.name, job.queue);
    await boss.updateQueue(job.name, updatable);
    await checkPolicy(boss, job, logger);
    // `includeMetadata`: trae `retryLimit`, para saber si es el último intento.
    await boss.work(job.name, { batchSize: 1, includeMetadata: true }, async (batch) => {
      for (const { id, data, retryCount, retryLimit } of batch) {
        await runOne(
          job,
          id,
          data,
          { retryCount, isLastAttempt: retryCount >= retryLimit },
          logger,
        );
      }
    });
    if (job.schedule !== undefined) {
      const { cron, tz, data, singletonKey } = job.schedule;
      // `missed: "skip"`: un cron perdido con el worker apagado no se repite al arrancar.
      await boss.schedule(job.name, cron, data, {
        tz,
        missed: "skip",
        ...(singletonKey === undefined ? {} : { singletonKey }),
      });
    }
  }
  return !isStopping();
}

/**
 * `createQueue` no cambia una cola que ya existe: si se creó con otra política (otro entorno, una
 * versión vieja), `singletonKey` podría no deduplicar. No se puede arreglar sin borrar la cola, así
 * que se avisa fuerte en el log.
 */
async function checkPolicy(boss: WorkerBoss, job: Job, logger: Logger): Promise<void> {
  const expected = job.queue.policy ?? "standard";
  const actual = (await boss.getQueue(job.name))?.policy ?? "standard";
  if (actual !== expected) {
    logger.error(
      { job: job.name, expected, actual },
      "la cola existe con otra política: hay que borrarla y recrearla para aplicar la del código",
    );
  }
}

const fullError = (error: unknown) => ({ err: error });

async function runOne(
  job: Job,
  jobId: string,
  data: unknown,
  attempt: { retryCount: number; isLastAttempt: boolean },
  logger: Logger,
): Promise<void> {
  // Los datos de un job son solo ids (ADR-0005): van al contexto del log, así cada error de un
  // intento queda con, por ejemplo, su `importRunId`.
  const jobLogger = logger.child({ job: job.name, jobId, data });
  const start = performance.now();
  const ms = () => Math.round(performance.now() - start);
  jobLogger.info("job iniciado");
  try {
    await job.run(data, { jobId, logger: jobLogger, ...attempt });
    jobLogger.info({ ms: ms() }, "job terminado");
  } catch (error) {
    const fields = { ...(job.errorLogFields ?? fullError)(error), ms: ms() };
    if (isAppError(error) && !error.retriable) {
      jobLogger.error(fields, "job falló sin reintento (error no reintentable)");
      return;
    }
    jobLogger.error(fields, "job falló; pg-boss lo reintentará si le quedan intentos");
    throw error;
  }
}
