import { Writable } from "node:stream";
import { createLogger } from "@agentsales/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PING_DELAY_MS, systemPing } from "./system-ping.js";

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
  return { promise: systemPing(data, { jobId: "j1", logger }), lines };
}

describe("systemPing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("registra pong con los datos recibidos", async () => {
    const { promise, lines } = run({ message: "hola" });
    await promise;

    expect(lines).toEqual([
      expect.objectContaining({ msg: "pong", data: { message: "hola" }, delayMs: 0 }),
    ]);
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

  it.each([
    [{ delayMs: 60_000 }, MAX_PING_DELAY_MS],
    [{ delayMs: -5 }, 0],
    [{ delayMs: "mucho" }, 0],
    [null, 0],
  ])("acota el retardo de %j a %i ms", async (data, expected) => {
    vi.useFakeTimers();
    const { promise, lines } = run(data);
    await vi.advanceTimersByTimeAsync(MAX_PING_DELAY_MS);
    await promise;

    expect(lines[0]).toMatchObject({ delayMs: expected });
  });
});
