import { PgBoss } from "pg-boss";

/** Esquema que crea pg-boss al arrancar el worker (ADR-0005). */
export const QUEUE_SCHEMA = "pgboss";

export type BossRole = "worker" | "producer";

/**
 * El productor refresca su caché de colas una vez al día (el tope de pg-boss), no cada 60 s: con
 * el valor por defecto, una API que encoló una vez consultaría Neon cada minuto y no lo dejaría
 * suspenderse (ADR-0007). Es seguro: una cola que no está en el caché se busca en la base.
 */
export const PRODUCER_QUEUE_CACHE_SECONDS = 24 * 60 * 60;

export type BossOptions = {
  /**
   * Conexión directa de Neon ya lista para `pg` (con `sslmode=verify-full`): la arma quien llama
   * con `toPgConnectionString` de `@agentsales/db` (los adaptadores no dependen entre sí).
   */
  connectionString: string;
  role: BossRole;
};

/**
 * Crea pg-boss (ADR-0005, ADR-0007).
 * - `worker`: procesa jobs; hace mantenimiento, supervisión y crea o migra el esquema `pgboss`.
 * - `producer`: solo encola (API y scripts): sin mantenimiento, supervisión ni migraciones, así
 *   que si el esquema no existe, `start` falla con "pg-boss is not installed".
 */
export function createBoss({ connectionString, role }: BossOptions): PgBoss {
  const isWorker = role === "worker";
  return new PgBoss({
    connectionString,
    schema: QUEUE_SCHEMA,
    application_name: `agentsales-${role}`,
    max: isWorker ? 3 : 1,
    supervise: isWorker,
    schedule: isWorker,
    migrate: isWorker,
    ...(isWorker ? {} : { queueCacheIntervalSeconds: PRODUCER_QUEUE_CACHE_SECONDS }),
  });
}
