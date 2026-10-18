import { createLogger } from "@agentsales/config";
import { WORKER_HEARTBEAT_RETENTION_MS } from "@agentsales/core";
import { createInMemoryWorkerHeartbeatRepository } from "@agentsales/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHeartbeat } from "./heartbeat.js";

// F8-T12 (spec F8 §4.10): el latido del worker cada minuto y el apagado anotado.

const T0 = new Date("2026-10-18T12:00:00.000Z");
const logger = createLogger({ level: "silent" });

describe("startHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("late al arrancar y cada minuto; al apagarse anota la hora y deja de latir", async () => {
    const heartbeats = createInMemoryWorkerHeartbeatRepository();
    const heartbeat = await startHeartbeat({
      heartbeats,
      processId: "mac:1:a",
      logger,
      errors: { report: () => {} },
    });
    expect((await heartbeats.listLatest(1))[0] ?? null).toEqual({
      processId: "mac:1:a",
      startedAt: T0,
      beatAt: T0,
      stoppedAt: null,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(((await heartbeats.listLatest(1))[0] ?? null)?.beatAt).toEqual(
      new Date(T0.getTime() + 60_000),
    );

    await heartbeat.stop();
    const stopped = (await heartbeats.listLatest(1))[0] ?? null;
    expect(stopped?.stoppedAt).toEqual(new Date(T0.getTime() + 60_000));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(((await heartbeats.listLatest(1))[0] ?? null)?.beatAt).toEqual(stopped?.beatAt);
  });

  it("borra los procesos de hace más de una semana al arrancar", async () => {
    const heartbeats = createInMemoryWorkerHeartbeatRepository();
    const old = new Date(T0.getTime() - WORKER_HEARTBEAT_RETENTION_MS - 1);
    await heartbeats.beat({ processId: "viejo", startedAt: old, at: old });
    await startHeartbeat({ heartbeats, processId: "nuevo", logger, errors: { report: () => {} } });
    expect(heartbeats.all().map((row) => row.processId)).toEqual(["nuevo"]);
  });

  it("un latido que falla no corta el worker: se resume y se reintenta al minuto", async () => {
    const heartbeats = createInMemoryWorkerHeartbeatRepository();
    const reported: unknown[] = [];
    let down = true;
    const flaky = {
      ...heartbeats,
      beat: async (input: Parameters<typeof heartbeats.beat>[0]) => {
        if (down) throw new Error("DB_UNAVAILABLE");
        await heartbeats.beat(input);
      },
    };
    await startHeartbeat({
      heartbeats: flaky,
      processId: "p",
      logger,
      errors: { report: (error) => reported.push(error) },
    });
    expect(reported).toHaveLength(1);
    down = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(((await heartbeats.listLatest(1))[0] ?? null)?.processId).toBe("p");
  });
});
