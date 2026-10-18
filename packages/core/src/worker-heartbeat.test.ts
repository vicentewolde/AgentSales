import { describe, expect, it } from "vitest";
import { WORKER_HEARTBEAT_STALE_MS, workerStatusOf, workerStatusText } from "./worker-heartbeat.js";

// F8-T12 (spec F8 §4.10): encendido o apagado según el último latido.

const NOW = new Date("2026-10-18T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const STARTED = ago(60 * 60_000);

describe("workerStatusOf", () => {
  it("sin latidos, nunca corrió", () => {
    expect(workerStatusOf([], NOW)).toEqual({
      running: false,
      startedAt: null,
      lastBeatAt: null,
    });
  });

  it("con un latido reciente está encendido desde que arrancó", () => {
    const beatAt = ago(30_000);
    expect(
      workerStatusOf([{ processId: "p", startedAt: STARTED, beatAt, stoppedAt: null }], NOW),
    ).toEqual({
      running: true,
      startedAt: STARTED.toISOString(),
      lastBeatAt: beatAt.toISOString(),
    });
  });

  it("sin latido en tres minutos está apagado (se cortó sin avisar)", () => {
    const beatAt = ago(WORKER_HEARTBEAT_STALE_MS);
    expect(
      workerStatusOf([{ processId: "p", startedAt: STARTED, beatAt, stoppedAt: null }], NOW)
        .running,
    ).toBe(false);
  });

  it("en un despliegue, el worker viejo que se apaga después no tapa al nuevo que ya corre", () => {
    const newStart = ago(40_000);
    const status = workerStatusOf(
      [
        { processId: "nuevo", startedAt: newStart, beatAt: newStart, stoppedAt: null },
        { processId: "viejo", startedAt: STARTED, beatAt: ago(10_000), stoppedAt: ago(5_000) },
      ],
      NOW,
    );
    expect(status).toEqual({
      running: true,
      startedAt: newStart.toISOString(),
      lastBeatAt: newStart.toISOString(),
    });
  });

  it("apagado en orden se ve apagado de inmediato, desde la hora en que se apagó", () => {
    const stoppedAt = ago(5_000);
    expect(
      workerStatusOf([{ processId: "p", startedAt: STARTED, beatAt: ago(20_000), stoppedAt }], NOW),
    ).toEqual({
      running: false,
      startedAt: STARTED.toISOString(),
      lastBeatAt: stoppedAt.toISOString(),
    });
  });
});

describe("workerStatusText", () => {
  it("dice encendido o apagado con la hora de Chile, o que no se sabe", () => {
    expect(workerStatusText(null)).toBe("no se pudo saber (la base no respondió)");
    expect(workerStatusText({ running: false, startedAt: null, lastBeatAt: null })).toBe(
      "nunca ha corrido",
    );
    expect(
      workerStatusText({
        running: true,
        startedAt: "2026-10-18T13:05:00.000Z",
        lastBeatAt: "2026-10-18T14:59:00.000Z",
      }),
    ).toBe("encendido desde 2026-10-18 10:05");
    expect(
      workerStatusText({
        running: false,
        startedAt: "2026-10-18T13:05:00.000Z",
        lastBeatAt: "2026-10-18T14:00:00.000Z",
      }),
    ).toBe("apagado desde 2026-10-18 11:00");
  });
});
