import { z } from "zod";
import { formatChileTime } from "./chile-time.js";

// El latido del worker (spec F8 §4.10 y T12): mientras corre, el worker anota cada minuto que sigue
// encendido (`worker_heartbeats`), y `/health` (administrador), `doctor` y el panel lo muestran como
// "encendido desde…" o "apagado". En modo demo (D1) es la forma de saber si quedó encendido.

/** Cada cuánto anota el worker su latido. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 60_000;

/** Sin latido en este tiempo (tres latidos perdidos), el worker se da por apagado. */
export const WORKER_HEARTBEAT_STALE_MS = 3 * WORKER_HEARTBEAT_INTERVAL_MS;

/** Los latidos de procesos que ya no corren se borran pasada una semana. */
export const WORKER_HEARTBEAT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Un proceso del worker: cuándo arrancó, su último latido y, si se apagó en orden, cuándo. */
export type WorkerHeartbeat = {
  processId: string;
  startedAt: Date;
  beatAt: Date;
  stoppedAt: Date | null;
};

/**
 * Lo que informa `/health` (desde F8-T12): si el worker está encendido, desde cuándo, y su último
 * latido (ISO). `startedAt` y `lastBeatAt` son `null` si nunca corrió.
 */
export const workerStatusSchema = z.object({
  running: z.boolean(),
  startedAt: z.string().nullable(),
  lastBeatAt: z.string().nullable(),
});
export type WorkerStatus = z.infer<typeof workerStatusSchema>;

/** Cuántos procesos recientes lee `/health` para decidir (`listLatest`). */
export const WORKER_HEARTBEAT_LOOKBACK = 5;

/**
 * El estado del worker según los procesos más recientes: encendido si alguno no se apagó en orden y
 * su latido es reciente (menos de `WORKER_HEARTBEAT_STALE_MS`), desde que arrancó ese. Así, en un
 * despliegue, el worker viejo que se apaga después del primer latido del nuevo no lo tapa. Si
 * ninguno corre, apagado desde el último latido (o apagado) del más reciente.
 */
export function workerStatusOf(processes: readonly WorkerHeartbeat[], now: Date): WorkerStatus {
  const isRunning = (process: WorkerHeartbeat) =>
    process.stoppedAt === null &&
    now.getTime() - process.beatAt.getTime() < WORKER_HEARTBEAT_STALE_MS;
  const byBeat = [...processes].sort((a, b) => b.beatAt.getTime() - a.beatAt.getTime());
  const running = byBeat.find(isRunning);
  if (running !== undefined) {
    return {
      running: true,
      startedAt: running.startedAt.toISOString(),
      lastBeatAt: running.beatAt.toISOString(),
    };
  }
  const latest = byBeat[0];
  if (latest === undefined) return { running: false, startedAt: null, lastBeatAt: null };
  return {
    running: false,
    startedAt: latest.startedAt.toISOString(),
    lastBeatAt: (latest.stoppedAt ?? latest.beatAt).toISOString(),
  };
}

/**
 * El estado del worker en una frase, con la hora de Chile, para `doctor`, `status` y el panel.
 * `null` es que la base no respondió.
 */
export function workerStatusText(status: WorkerStatus | null): string {
  if (status === null) return "no se pudo saber (la base no respondió)";
  if (status.startedAt === null || status.lastBeatAt === null) return "nunca ha corrido";
  return status.running
    ? `encendido desde ${formatChileTime(new Date(status.startedAt))}`
    : `apagado desde ${formatChileTime(new Date(status.lastBeatAt))}`;
}
