import { describe, expect, it } from "vitest";
import {
  addDays,
  byChileDay,
  dayLabel,
  periodLabel,
  rangeOfDays,
  shiftAnchor,
  startOfWeek,
  validDay,
  visibleDays,
} from "./calendar.js";

// F9-T18: los días del calendario del panel, en hora de Chile (también con el cambio de horario).

describe("los días a la vista", () => {
  it("la semana va de lunes a domingo", () => {
    expect(visibleDays("semana", "2026-10-21")).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
    ]);
    expect(startOfWeek("2026-10-25")).toBe("2026-10-19");
    expect(startOfWeek("2026-10-19")).toBe("2026-10-19");
  });

  it("el mes cubre semanas completas: de 4 a 6, como mucho 42 días", () => {
    const october = visibleDays("mes", "2026-10-20");
    expect([october[0], october.at(-1), october.length]).toEqual(["2026-09-28", "2026-11-01", 35]);
    // Febrero de 2027 empieza un lunes y tiene 28 días: cuatro semanas justas.
    expect(visibleDays("mes", "2027-02-10")).toHaveLength(28);
    // Agosto de 2026 empieza un sábado y termina un lunes: seis semanas.
    const august = visibleDays("mes", "2026-08-15");
    expect([august[0], august.at(-1), august.length]).toEqual(["2026-07-27", "2026-09-06", 42]);
  });

  it("avanza y retrocede una semana o un mes, también entre años", () => {
    expect(shiftAnchor("semana", "2026-10-21", 1)).toBe("2026-10-26");
    expect(shiftAnchor("semana", "2026-10-21", -1)).toBe("2026-10-12");
    expect(shiftAnchor("mes", "2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftAnchor("mes", "2026-03-31", -1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("solo acepta días que existen", () => {
    expect(validDay("2026-10-19")).toBe("2026-10-19");
    expect(validDay("2026-02-30")).toBeUndefined();
    expect(validDay("2026-10-1")).toBeUndefined();
    expect(validDay(null)).toBeUndefined();
  });
});

describe("el rango en hora de Chile", () => {
  it("de la medianoche de Chile del primer día a la del día siguiente al último", () => {
    expect(rangeOfDays(visibleDays("semana", "2026-10-21"))).toEqual({
      from: new Date("2026-10-19T03:00:00.000Z"),
      to: new Date("2026-10-26T03:00:00.000Z"),
    });
  });

  it("la semana del cambio de hora (6 de septiembre, se adelanta) dura una hora menos", () => {
    const { from, to } = rangeOfDays(visibleDays("semana", "2026-09-06"));
    // Lunes 31 de agosto, invierno (UTC-4), al lunes 7 de septiembre, verano (UTC-3).
    expect(from.toISOString()).toBe("2026-08-31T04:00:00.000Z");
    expect(to.toISOString()).toBe("2026-09-07T03:00:00.000Z");
    expect(to.getTime() - from.getTime()).toBe((7 * 24 - 1) * 60 * 60 * 1000);
  });

  it("la semana del cambio de abril (se atrasa) dura una hora más", () => {
    const { from, to } = rangeOfDays(visibleDays("semana", "2027-04-04"));
    expect(to.getTime() - from.getTime()).toBe((7 * 24 + 1) * 60 * 60 * 1000);
  });

  it("cada entrada va a su día de Chile, no al de UTC", () => {
    const days = byChileDay([
      // 23:30 del 14 en Chile (UTC-3).
      { id: "a", at: new Date("2026-10-15T02:30:00.000Z") },
      // 01:30 del 6 de septiembre: la primera hora de ese día, ya en verano.
      { id: "b", at: new Date("2026-09-06T04:30:00.000Z") },
      // 23:30 del 5 de septiembre, todavía en invierno (UTC-4).
      { id: "c", at: new Date("2026-09-06T03:30:00.000Z") },
    ]);
    expect(days.get("2026-10-14")?.map((e) => e.id)).toEqual(["a"]);
    expect(days.get("2026-09-06")?.map((e) => e.id)).toEqual(["b"]);
    expect(days.get("2026-09-05")?.map((e) => e.id)).toEqual(["c"]);
  });
});

describe("los títulos", () => {
  it("el día, la semana y el mes en español", () => {
    expect(dayLabel("2026-10-19")).toBe("lunes 19 de octubre");
    expect(periodLabel("semana", "2026-10-21")).toBe("Semana del 19 al 25 de octubre de 2026");
    expect(periodLabel("semana", "2026-09-30")).toBe(
      "Semana del 28 de septiembre al 4 de octubre de 2026",
    );
    expect(periodLabel("semana", "2026-12-30")).toBe(
      "Semana del 28 de diciembre de 2026 al 3 de enero de 2027",
    );
    expect(periodLabel("mes", "2026-10-20")).toBe("Octubre de 2026");
  });
});
