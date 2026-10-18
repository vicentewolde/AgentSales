import { hostname } from "node:os";
import type { Logger } from "@agentsales/config";
import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_RETENTION_MS,
  type WorkerHeartbeatRepository,
} from "@agentsales/core";

// El latido del worker (spec F8 §4.10, T12): al arrancar y cada minuto anota que sigue encendido;
// al apagarse en orden, anota la hora. `/health`, `doctor` y el panel lo leen.

export type HeartbeatDeps = {
  heartbeats: WorkerHeartbeatRepository;
  /** Este proceso: el nombre de la máquina, el pid y un sufijo propio (un reinicio es otro). */
  processId: string;
  logger: Logger;
  /** Resume los errores repetidos (la base caída cada minuto no inunda el log). */
  errors: { report(error: unknown): void };
  now?: () => Date;
  intervalMs?: number;
};

export type Heartbeat = {
  /** Deja de latir y anota que el proceso se apagó (antes de cerrar la base). */
  stop(): Promise<void>;
};

/** El identificador de este proceso del worker. */
export const workerProcessId = (suffix: string) => `${hostname()}:${process.pid}:${suffix}`;

/**
 * Empieza a latir: un latido ya (y borra los procesos de hace más de una semana) y otro cada
 * minuto. Un latido que falla no corta el worker: se resume en el log y se reintenta al siguiente.
 */
export async function startHeartbeat(deps: HeartbeatDeps): Promise<Heartbeat> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const beat = async () => {
    try {
      await deps.heartbeats.beat({ processId: deps.processId, startedAt, at: now() });
    } catch (error) {
      deps.errors.report(error);
    }
  };
  await beat();
  try {
    const before = new Date(startedAt.getTime() - WORKER_HEARTBEAT_RETENTION_MS);
    const deleted = await deps.heartbeats.deleteOlderThan(before);
    if (deleted > 0) deps.logger.debug({ count: deleted }, "latidos viejos borrados");
  } catch (error) {
    deps.logger.warn({ err: error }, "no se pudieron borrar los latidos viejos");
  }
  const timer = setInterval(() => void beat(), deps.intervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      try {
        await deps.heartbeats.stop(deps.processId, now());
      } catch (error) {
        deps.logger.warn({ err: error }, "no se pudo anotar el apagado del worker");
      }
    },
  };
}
