import type { JobName, JobPayload } from "../jobs.js";

export type EnqueueOptions = {
  /** No antes de esta fecha (programar). */
  startAfter?: Date;
  /** Un solo job activo con esta clave en la cola (por ejemplo, el id del run). */
  singletonKey?: string;
};

/**
 * Puerto para encolar jobs (ADR-0005): lo usan la API y los scripts; el worker los procesa.
 * Errores (`AppError`):
 * - datos que no calzan con `JOB_PAYLOADS[name]` → `JOB_PAYLOAD_INVALID`, sin encolar (un bug);
 * - la cola no está disponible (sin conexión, el esquema `pgboss` no existe o la cola no se creó
 *   porque el worker nunca arrancó) → `QUEUE_UNAVAILABLE`, reintentable.
 */
export interface JobQueue {
  /**
   * Encola y devuelve el id del job, o `null` si no se creó porque ya había uno con el mismo
   * `singletonKey`. Eso depende de la **política de la cola**: en pg-boss solo deduplican
   * `singleton`, `stately`, `exclusive`… y no la estándar, y la política no se puede cambiar
   * después de crear la cola (F1-T09 define la de `import.run`).
   */
  enqueue<N extends JobName>(
    name: N,
    data: JobPayload<N>,
    options?: EnqueueOptions,
  ): Promise<string | null>;
}
