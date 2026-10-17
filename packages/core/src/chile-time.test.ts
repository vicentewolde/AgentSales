import { describe, expect, it } from "vitest";
import {
  chileInputValue,
  chileMonthOf,
  chileMonthRange,
  formatChileTime,
  parseChileTime,
} from "./chile-time.js";
import { isAppError } from "./errors.js";

// F6-T11 y T12: la hora de Chile ida y vuelta, también con el cambio de horario (CLI y panel).

describe("parseChileTime y formatChileTime", () => {
  it("en verano (UTC−3) y en invierno (UTC−4), ida y vuelta", () => {
    const summer = parseChileTime("2026-10-19 10:00");
    expect(summer.toISOString()).toBe("2026-10-19T13:00:00.000Z");
    expect(formatChileTime(summer)).toBe("2026-10-19 10:00");

    const winter = parseChileTime("2026-07-01 9:30");
    expect(winter.toISOString()).toBe("2026-07-01T13:30:00.000Z");
    expect(formatChileTime(winter)).toBe("2026-07-01 09:30");
  });

  it("una hora que no existe por el adelanto del reloj se rechaza; una repetida toma la primera vez", () => {
    // Septiembre de 2026: a las 00:00 del primer domingo el reloj salta a la 01:00.
    expect(() => parseChileTime("2026-09-06 00:30")).toThrow(/no existen en Chile/);
    // Abril de 2026: a las 00:00 del primer domingo vuelve a las 23:00 del sábado (se repite).
    const twice = parseChileTime("2026-04-04 23:30");
    expect(twice.toISOString()).toBe("2026-04-05T02:30:00.000Z");
    expect(formatChileTime(twice)).toBe("2026-04-04 23:30");
  });

  it("otro formato es SCHEDULE_AT_INVALID con el ejemplo", () => {
    for (const text of [
      "19-10-2026 10:00",
      "2026-10-19",
      "mañana 10:00",
      "2026-13-01 10:00",
      "2026-02-30 10:00",
      "2026-10-19 25:00",
    ]) {
      let caught: unknown;
      try {
        parseChileTime(text);
      } catch (error) {
        caught = error;
      }
      expect(isAppError(caught) && caught.code).toBe("SCHEDULE_AT_INVALID");
      expect((caught as Error).message).toContain("AAAA-MM-DD HH:MM");
    }
  });
});

describe("chileInputValue", () => {
  it("el valor del selector del panel, que parseChileTime vuelve a leer", () => {
    const at = parseChileTime("2026-10-19T10:00");
    expect(chileInputValue(at)).toBe("2026-10-19T10:00");
  });
});

describe("el mes de Chile (F7-T02: el gasto del mes)", () => {
  it("es el rango [desde, hasta) en hora de Chile, con el horario de cada borde", () => {
    // Octubre empieza en horario de verano (−3) y termina igual.
    expect(chileMonthRange("2026-10")).toEqual({
      from: new Date("2026-10-01T03:00:00.000Z"),
      to: new Date("2026-11-01T03:00:00.000Z"),
    });
    // Julio empieza y termina en invierno (−4).
    expect(chileMonthRange("2026-07")).toEqual({
      from: new Date("2026-07-01T04:00:00.000Z"),
      to: new Date("2026-08-01T04:00:00.000Z"),
    });
    // Diciembre pasa al año siguiente.
    expect(chileMonthRange("2026-12").to).toEqual(new Date("2027-01-01T03:00:00.000Z"));
  });

  it("un instante cerca de la medianoche cae en el mes de Chile, no en el de UTC", () => {
    // 1 de noviembre a las 02:30 UTC son las 23:30 del 31 de octubre en Chile.
    expect(chileMonthOf(new Date("2026-11-01T02:30:00Z"))).toBe("2026-10");
    expect(chileMonthOf(new Date("2026-11-01T03:00:00Z"))).toBe("2026-11");
  });

  it("un mes mal escrito es MONTH_INVALID", () => {
    for (const month of ["2026-13", "2026-1", "octubre", "2026-00"]) {
      expect(() => chileMonthRange(month)).toThrow(
        expect.objectContaining({ code: "MONTH_INVALID" }),
      );
    }
  });
});
