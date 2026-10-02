import type { AppError } from "../errors.js";
import type { JobName } from "../jobs.js";
import type { EnqueueOptions, JobQueue } from "../ports/job-queue.js";

export type EnqueuedJob = { name: JobName; data: unknown; options: EnqueueOptions };

export type InMemoryJobQueue = JobQueue & { jobs: EnqueuedJob[] };

/**
 * `JobQueue` en memoria: guarda lo encolado. No valida los datos contra `JOB_PAYLOADS` (los ids
 * de los dobles no son uuid); eso lo prueba el adaptador. `fail` simula una cola caída.
 */
export function createInMemoryJobQueue(
  options: { fail?: () => AppError | undefined } = {},
): InMemoryJobQueue {
  const jobs: EnqueuedJob[] = [];
  return {
    jobs,
    async enqueue(name, data, enqueueOptions = {}) {
      const failure = options.fail?.();
      if (failure !== undefined) throw failure;
      jobs.push({ name, data, options: enqueueOptions });
      return `job-${jobs.length}`;
    },
  };
}
