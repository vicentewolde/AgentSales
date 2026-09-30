import type { Logger } from "@agentsales/config";

export type JobContext = { jobId: string; logger: Logger };

/** Un handler por nombre de job. Debe ser idempotente: pg-boss puede reintentarlo (ADR-0005). */
export type JobHandler = (data: unknown, context: JobContext) => Promise<void>;

export type JobRegistry = Readonly<Record<string, JobHandler>>;

/** Lo que el registro usa de pg-boss; `PgBoss` lo cumple. */
export type WorkerBoss = {
  createQueue(name: string): Promise<void>;
  work(
    name: string,
    handler: (jobs: { id: string; data: unknown }[]) => Promise<void>,
  ): Promise<string>;
};

/**
 * Crea la cola de cada job (idempotente) y registra su handler. Cada ejecución queda en el log
 * con su duración; si el handler lanza, el error se propaga para que pg-boss lo reintente.
 */
export async function registerJobs(
  boss: WorkerBoss,
  registry: JobRegistry,
  logger: Logger,
): Promise<void> {
  for (const [name, handler] of Object.entries(registry)) {
    await boss.createQueue(name);
    await boss.work(name, async (jobs) => {
      for (const job of jobs) {
        const jobLogger = logger.child({ job: name, jobId: job.id });
        const start = performance.now();
        const ms = () => Math.round(performance.now() - start);
        jobLogger.info("job iniciado");
        try {
          await handler(job.data, { jobId: job.id, logger: jobLogger });
          jobLogger.info({ ms: ms() }, "job terminado");
        } catch (error) {
          jobLogger.error({ err: error, ms: ms() }, "job falló");
          throw error;
        }
      }
    });
  }
}
