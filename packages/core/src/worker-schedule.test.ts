import { describe, expect, it } from "vitest";
import { formatChileTime } from "./chile-time.js";
import {
  nextWorkerWindow,
  nextWorkerWindowText,
  WORKER_WINDOWS,
  workerWindowsText,
} from "./worker-schedule.js";

// F9.5-T24 (ADR-0037): la próxima ventana del horario del worker, en hora de Chile.

const at = (iso: string) => new Date(iso);
const chile = (date: Date | null) => (date === null ? null : formatChileTime(date));

describe("nextWorkerWindow", () => {
  it("antes de la primera ventana del día, esa; entre ventanas, la siguiente; después, la de mañana", () => {
    // Octubre: Chile va a UTC−3.
    expect(chile(nextWorkerWindow(at("2026-10-22T10:00:00Z")))).toBe("2026-10-22 09:00"); // 07:00
    expect(chile(nextWorkerWindow(at("2026-10-22T15:00:00Z")))).toBe("2026-10-22 17:00"); // 12:00
    expect(chile(nextWorkerWindow(at("2026-10-22T22:00:00Z")))).toBe("2026-10-23 09:00"); // 19:00
  });

  it("justo a la hora de una ventana, la siguiente (la que empieza después)", () => {
    expect(chile(nextWorkerWindow(at("2026-10-22T12:00:00Z")))).toBe("2026-10-22 17:00"); // 09:00
  });

  it("con el horario de invierno (UTC−4) también", () => {
    expect(nextWorkerWindow(at("2026-07-01T12:00:00Z"))?.toISOString()).toBe(
      "2026-07-01T13:00:00.000Z",
    );
  });

  it("sin ventanas, null; el orden en que vienen no importa", () => {
    expect(nextWorkerWindow(at("2026-10-22T10:00:00Z"), [])).toBeNull();
    expect(chile(nextWorkerWindow(at("2026-10-22T15:00:00Z"), ["17:00", "09:00"]))).toBe(
      "2026-10-22 17:00",
    );
  });
});

describe("textos del horario", () => {
  it("las ventanas en una frase y la próxima con su hora", () => {
    expect(WORKER_WINDOWS).toEqual(["09:00", "17:00"]);
    expect(workerWindowsText()).toBe("09:00 y 17:00");
    expect(workerWindowsText(["08:00", "13:00", "18:00"])).toBe("08:00, 13:00 y 18:00");
    expect(nextWorkerWindowText(at("2026-10-22T15:00:00Z"))).toBe("2026-10-22 17:00");
    expect(nextWorkerWindowText(at("2026-10-22T15:00:00Z"), [])).toBe("sin ventanas");
  });
});
