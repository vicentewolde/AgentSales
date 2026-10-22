import { describe, expect, it } from "vitest";
import { formatChileTime } from "./chile-time.js";
import {
  isWorkerCheckTime,
  nextWorkerCheck,
  nextWorkerCheckText,
  WORKER_ACTIVE_HOURS,
  workerScheduleText,
} from "./worker-schedule.js";

// F9.5-T24 (ADR-0037): la próxima revisión del horario del worker (cada hora a los :50, de día),
// en hora de Chile.

const at = (iso: string) => new Date(iso);
const chile = (date: Date | null) => (date === null ? null : formatChileTime(date));

describe("nextWorkerCheck", () => {
  it("de día, la próxima hora :50 (horario de verano, UTC−3)", () => {
    expect(chile(nextWorkerCheck(at("2026-10-22T13:00:00Z")))).toBe("2026-10-22 10:50"); // 10:00
    expect(chile(nextWorkerCheck(at("2026-10-22T13:55:00Z")))).toBe("2026-10-22 11:50"); // 10:55
  });

  it("justo a la hora de una revisión, la siguiente", () => {
    expect(chile(nextWorkerCheck(at("2026-10-22T13:50:00Z")))).toBe("2026-10-22 11:50"); // 10:50
  });

  it("de noche, la primera de la mañana (06:50); la última del día es la de las 22:50", () => {
    expect(chile(nextWorkerCheck(at("2026-10-23T01:30:00Z")))).toBe("2026-10-22 22:50"); // 22:30
    expect(chile(nextWorkerCheck(at("2026-10-23T02:00:00Z")))).toBe("2026-10-23 06:50"); // 23:00
    expect(chile(nextWorkerCheck(at("2026-10-23T06:00:00Z")))).toBe("2026-10-23 06:50"); // 03:00
  });

  it("con el horario de invierno (UTC−4) también", () => {
    // 2026-07-01 08:00 en Chile.
    expect(nextWorkerCheck(at("2026-07-01T12:00:00Z"))?.toISOString()).toBe(
      "2026-07-01T12:50:00.000Z",
    );
    // 2026-07-01 23:10 en Chile: la de las 06:50 del día siguiente.
    expect(nextWorkerCheck(at("2026-07-02T03:10:00Z"))?.toISOString()).toBe(
      "2026-07-02T10:50:00.000Z",
    );
  });

  it("una franja sin revisiones da null", () => {
    expect(nextWorkerCheck(at("2026-10-22T13:00:00Z"), { from: "10:00", until: "09:50" })).toBeNull();
  });
});

describe("la franja y los textos", () => {
  it("de 06:50 a 22:50 con la franja de 07:00 a 23:00", () => {
    expect(WORKER_ACTIVE_HOURS).toEqual({ from: "07:00", until: "23:00" });
    expect(isWorkerCheckTime(6 * 60 + 50)).toBe(true);
    expect(isWorkerCheckTime(5 * 60 + 50)).toBe(false);
    expect(isWorkerCheckTime(22 * 60 + 50)).toBe(true);
    expect(isWorkerCheckTime(23 * 60 + 50)).toBe(false);
    expect(workerScheduleText()).toBe("cada hora a los :50, de 06:50 a 22:50, hora de Chile");
    expect(nextWorkerCheckText(at("2026-10-22T13:00:00Z"))).toBe("2026-10-22 10:50");
  });
});
