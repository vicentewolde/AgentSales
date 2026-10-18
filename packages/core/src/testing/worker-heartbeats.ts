import type { WorkerHeartbeatRepository } from "../ports/worker-heartbeat-repository.js";
import type { WorkerHeartbeat } from "../worker-heartbeat.js";
import { structuredCopy } from "./copy.js";

export type InMemoryWorkerHeartbeatRepository = WorkerHeartbeatRepository & {
  /** Todos los procesos anotados, para revisar. */
  all(): WorkerHeartbeat[];
};

/** `WorkerHeartbeatRepository` en memoria (F8-T12): copia al guardar y al leer, como la base. */
export function createInMemoryWorkerHeartbeatRepository(): InMemoryWorkerHeartbeatRepository {
  const rows = new Map<string, WorkerHeartbeat>();
  return {
    async beat({ processId, startedAt, at }) {
      const current = rows.get(processId);
      rows.set(
        processId,
        current === undefined
          ? { processId, startedAt: new Date(startedAt), beatAt: new Date(at), stoppedAt: null }
          : { ...current, beatAt: new Date(at) },
      );
    },
    async stop(processId, at) {
      const current = rows.get(processId);
      if (current !== undefined) rows.set(processId, { ...current, stoppedAt: new Date(at) });
    },
    async listLatest(limit) {
      return [...rows.values()]
        .sort((a, b) => b.beatAt.getTime() - a.beatAt.getTime())
        .slice(0, limit)
        .map(structuredCopy);
    },
    async deleteOlderThan(before) {
      let deleted = 0;
      for (const [id, row] of rows) {
        if (row.beatAt < before) {
          rows.delete(id);
          deleted += 1;
        }
      }
      return deleted;
    },
    all: () => [...rows.values()].map(structuredCopy),
  };
}
