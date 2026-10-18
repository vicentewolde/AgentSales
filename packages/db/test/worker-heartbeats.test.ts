import type { WorkerHeartbeatRepository } from "@agentsales/core";
import { createInMemoryWorkerHeartbeatRepository } from "@agentsales/core/testing";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWorkerHeartbeatRepository } from "../src/repositories/worker-heartbeats.js";
import { createTestDatabase } from "./pglite.js";

const T0 = new Date("2026-10-18T12:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

/**
 * Suite de contrato de `WorkerHeartbeatRepository` (F8-T12): igual contra el doble en memoria y
 * contra Drizzle sobre PGlite.
 */
function workerHeartbeatContract(name: string, make: () => Promise<WorkerHeartbeatRepository>) {
  describe(`${name} · WorkerHeartbeatRepository`, () => {
    let repository: WorkerHeartbeatRepository;
    beforeAll(async () => {
      repository = await make();
    });
    // Una sola base por suite (PGlite tarda en crearse): cada prueba parte vacía.
    beforeEach(async () => {
      await repository.deleteOlderThan(new Date("2100-01-01T00:00:00.000Z"));
    });

    it("sin latidos no hay proceso; el primero lo crea y los siguientes mueven solo el latido", async () => {
      expect((await repository.listLatest(1))[0] ?? null).toBeNull();
      await repository.beat({ processId: "a", startedAt: T0, at: T0 });
      await repository.beat({ processId: "a", startedAt: at(5), at: at(1) });

      expect((await repository.listLatest(1))[0] ?? null).toEqual({
        processId: "a",
        startedAt: T0,
        beatAt: at(1),
        stoppedAt: null,
      });
    });

    it("el más reciente es el del último latido; apagar anota la hora", async () => {
      await repository.beat({ processId: "viejo", startedAt: T0, at: at(2) });
      await repository.beat({ processId: "nuevo", startedAt: at(3), at: at(3) });
      await repository.stop("nuevo", at(4));

      expect((await repository.listLatest(1))[0] ?? null).toEqual({
        processId: "nuevo",
        startedAt: at(3),
        beatAt: at(3),
        stoppedAt: at(4),
      });
      // Apagar uno que no existe no falla.
      await repository.stop("otro", at(5));
    });

    it("lista los más recientes primero, hasta el límite", async () => {
      await repository.beat({ processId: "a", startedAt: T0, at: at(1) });
      await repository.beat({ processId: "b", startedAt: T0, at: at(3) });
      await repository.beat({ processId: "c", startedAt: T0, at: at(2) });

      expect((await repository.listLatest(2)).map((row) => row.processId)).toEqual(["b", "c"]);
    });

    it("borra los procesos con el último latido anterior a la fecha", async () => {
      await repository.beat({ processId: "viejo", startedAt: T0, at: T0 });
      await repository.beat({ processId: "nuevo", startedAt: at(10), at: at(10) });

      expect(await repository.deleteOlderThan(at(5))).toBe(1);
      expect(((await repository.listLatest(1))[0] ?? null)?.processId).toBe("nuevo");
      expect(await repository.deleteOlderThan(at(5))).toBe(0);
    });
  });
}

workerHeartbeatContract("en memoria", async () => createInMemoryWorkerHeartbeatRepository());
workerHeartbeatContract("Drizzle sobre PGlite", async () => {
  const { db } = await createTestDatabase();
  return createWorkerHeartbeatRepository(db);
});
