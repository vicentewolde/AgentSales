import { QUEUE_SCHEMA, toPgConnectionString } from "@agentsales/db";
import { PgBoss } from "pg-boss";

export type BossRole = "worker" | "producer";

/**
 * Crea pg-boss sobre la conexión directa de Neon con `sslmode=verify-full` (ADR-0005, ADR-0007).
 * - `worker`: procesa jobs; hace mantenimiento, supervisión y crea o migra el esquema `pgboss`.
 * - `producer`: solo encola (scripts; la API cuando encole): sin mantenimiento ni supervisión.
 *
 * Adaptador de la cola en F0: vive aquí porque solo lo usa el worker. En la primera fase en que la
 * API encole (F1 si se adopta `import.run`; si no, F2) se extrae a `packages/queue` implementando
 * el puerto `JobQueue` de core (docs/01-arquitectura.md).
 */
export function createBoss(databaseUrl: string, role: BossRole): PgBoss {
  const isWorker = role === "worker";
  return new PgBoss({
    connectionString: toPgConnectionString(databaseUrl),
    schema: QUEUE_SCHEMA,
    application_name: `agentsales-${role}`,
    max: isWorker ? 3 : 1,
    supervise: isWorker,
    schedule: isWorker,
    migrate: isWorker,
  });
}
