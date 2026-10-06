import { Writable } from "node:stream";
import { createLogger } from "@agentsales/config";
import { MAX_PING_DELAY_MS } from "@agentsales/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { systemPing } from "./system-ping.js";

function run(data: unknown) {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(
    { level: "info" },
    new Writable({
      write(chunk, _encoding, callback) {
        lines.push(JSON.parse(chunk.toString()));
        callback();
      },
    }),
  );
  return {
    promise: systemPing.run(data, { jobId: "j1", logger, isLastAttempt: true, retryCount: 0 }),
    lines,
  };
}

describe("systemPing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("no se reintenta y expira pronto", () => {
    expect(systemPing.queue).toMatchObject({ retryLimit: 0, expireInSeconds: 60 });
  });

  it("registra pong con el mensaje recibido", async () => {
    const { promise, lines } = run({ message: "hola" });
    await promise;

    expect(lines).toEqual([expect.objectContaining({ msg: "pong", message: "hola", delayMs: 0 })]);
  });

  it("espera delayMs antes de responder", async () => {
    vi.useFakeTimers();
    const { promise, lines } = run({ delayMs: 3000 });

    await vi.advanceTimersByTimeAsync(2999);
    expect(lines).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(lines[0]).toMatchObject({ msg: "pong", delayMs: 3000 });
  });

  it.each([{ delayMs: MAX_PING_DELAY_MS + 1 }, { delayMs: -5 }, { delayMs: "mucho" }, null])(
    "rechaza datos inválidos (%j) sin reintento",
    async (data) => {
      await expect(run(data).promise).rejects.toMatchObject({
        code: "JOB_PAYLOAD_INVALID",
        retriable: false,
      });
    },
  );
});
