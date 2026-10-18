import type { WorkerHeartbeat } from "../worker-heartbeat.js";

/**
 * Los latidos del worker (`worker_heartbeats`, spec F8 §4.10): una fila por proceso. Errores: la
 * base caída → `DB_UNAVAILABLE` (reintentable).
 */
export interface WorkerHeartbeatRepository {
  /** Anota el latido de un proceso: lo crea con `startedAt` o le pone `beatAt` al que ya estaba. */
  beat(input: { processId: string; startedAt: Date; at: Date }): Promise<void>;
  /** El proceso se apagó en orden (`stoppedAt`): se ve apagado sin esperar a que su latido venza. */
  stop(processId: string, at: Date): Promise<void>;
  /** Los `limit` procesos con el latido más reciente, del más nuevo al más viejo. */
  listLatest(limit: number): Promise<WorkerHeartbeat[]>;
  /** Borra los procesos con el último latido anterior a `before`; devuelve cuántos. */
  deleteOlderThan(before: Date): Promise<number>;
}
