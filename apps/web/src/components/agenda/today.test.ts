import { afterEach, describe, expect, it, vi } from "vitest";
import { daySummary, greeting, greetingLine, todayText } from "./today.js";

// F9.5-T26: el saludo de «Hoy» por la hora de Chile (en octubre, UTC−3) y la frase del día.

afterEach(() => {
  vi.useRealTimers();
});

/** Fija el reloj en esa hora de Chile y saluda con «ahora». */
const at = (chileTime: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`2026-10-22T${chileTime}:00-03:00`));
  return greeting(new Date());
};

describe("el saludo en hora de Chile", () => {
  it.each([
    ["04:59", "Buenas noches"],
    ["05:00", "Buenos días"],
    ["11:59", "Buenos días"],
    ["12:00", "Buenas tardes"],
    ["19:59", "Buenas tardes"],
    ["20:00", "Buenas noches"],
  ])("a las %s dice «%s»", (time, expected) => {
    expect(at(time)).toBe(expected);
  });

  it("no depende de la zona del equipo: 15:00 UTC son las 12:00 en Chile", () => {
    expect(greeting(new Date("2026-10-22T15:00:00Z"))).toBe("Buenas tardes");
  });

  it("saluda con el primer nombre, y sin nombre solo saluda", () => {
    const now = new Date("2026-10-22T09:00:00-03:00");
    expect(greetingLine(now, "  Vicente Wolde ")).toBe("Buenos días, Vicente");
    expect(greetingLine(now, undefined)).toBe("Buenos días");
    expect(greetingLine(now, "   ")).toBe("Buenos días");
  });

  it("dice la fecha de Chile con mayúscula", () => {
    // 01:00 UTC del 23 todavía es el 22 en Chile.
    expect(todayText(new Date("2026-10-23T01:00:00Z"))).toMatch(/^Jueves,? 22 de octubre$/);
  });
});

describe("la frase del día", () => {
  it("mientras carga, nada", () => {
    expect(daySummary(undefined, 2)).toBeNull();
    expect(daySummary(1, undefined)).toBeNull();
  });

  it("en singular y en plural", () => {
    expect(daySummary(1, 1)).toBe(
      "Hoy 1 cosa te espera. En los próximos 7 días sale 1 publicación.",
    );
    expect(daySummary(3, 5)).toBe(
      "Hoy 3 cosas te esperan. En los próximos 7 días salen 5 publicaciones.",
    );
  });

  it("sin nada pendiente ni programado", () => {
    expect(daySummary(0, 0)).toBe(
      "Hoy no tienes nada pendiente. En los próximos 7 días no hay nada programado.",
    );
  });
});
