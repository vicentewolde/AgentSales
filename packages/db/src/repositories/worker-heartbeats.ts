import type { WorkerHeartbeatRepository } from "@agentsales/core";
import { desc, eq, lt } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { withDbErrors } from "../errors.js";
import { workerHeartbeats } from "../schema.js";

/** `WorkerHeartbeatRepository` sobre Drizzle (spec F8 §4.10, T12): la tabla `worker_heartbeats`. */
export function createWorkerHeartbeatRepository(db: SchemaDatabase): WorkerHeartbeatRepository {
  return {
    async beat({ processId, startedAt, at }) {
      await withDbErrors(() =>
        db
          .insert(workerHeartbeats)
          .values({ processId, startedAt, beatAt: at })
          .onConflictDoUpdate({ target: workerHeartbeats.processId, set: { beatAt: at } }),
      );
    },

    async stop(processId, at) {
      await withDbErrors(() =>
        db
          .update(workerHeartbeats)
          .set({ stoppedAt: at })
          .where(eq(workerHeartbeats.processId, processId)),
      );
    },

    async listLatest(limit) {
      return withDbErrors(() =>
        db.select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.beatAt)).limit(limit),
      );
    },

    async deleteOlderThan(before) {
      return withDbErrors(async () => {
        const deleted = await db
          .delete(workerHeartbeats)
          .where(lt(workerHeartbeats.beatAt, before))
          .returning({ processId: workerHeartbeats.processId });
        return deleted.length;
      });
    },
  };
}
