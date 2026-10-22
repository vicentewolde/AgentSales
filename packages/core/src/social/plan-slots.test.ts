import { describe, expect, it } from "vitest";
import { chileDateStart, formatChileTime } from "../chile-time.js";
import { addDays, planSlotBook, planSlotRules, planSlots } from "./plan-slots.js";

// Las ranuras del plan (spec F9.5, D7; ADR-0034): funciones puras, en hora de Chile.

const daysFrom = (first: string, n: number) =>
  Array.from({ length: n }, (_, index) => addDays(first, index));

const bounds = (first: string, n: number, now: Date) => ({
  days: daysFrom(first, n),
  start: chileDateStart(first),
  end: chileDateStart(addDays(first, n)),
  now,
});

describe("las ranuras de una red", () => {
  it("los días y horas de su cadencia en el período, desde ahora y en orden", () => {
    // Del lunes 26 al domingo 1; ahora es el lunes 26 a las 09:30 de Chile.
    const now = new Date("2026-10-26T12:30:00Z");
    const slots = planSlots(
      planSlotRules({ postsPerWeek: 3, days: ["mon", "wed"], hours: ["18:00", "09:00"] }),
      bounds("2026-10-26", 7, now),
    );
    expect(slots.map((slot) => formatChileTime(slot.at))).toEqual([
      "2026-10-26 18:00",
      "2026-10-28 09:00",
      "2026-10-28 18:00",
    ]);
    // Con 0 posts por semana, ninguna.
    expect(
      planSlots(
        planSlotRules({ postsPerWeek: 0, days: [], hours: [] }),
        bounds("2026-10-26", 7, now),
      ),
    ).toEqual([]);
  });

  it("una hora que no existe en Chile (el día que se adelanta el reloj) no es ranura", () => {
    // El domingo 5 de septiembre de 2027 el reloj salta de las 00:00 a la 01:00.
    const slots = planSlots(
      planSlotRules({ postsPerWeek: 7, days: ["sun"], hours: ["00:30", "10:00"] }),
      bounds("2027-09-05", 1, new Date("2027-09-01T12:00:00Z")),
    );
    expect(slots.map((slot) => formatChileTime(slot.at))).toEqual(["2027-09-05 10:00"]);
  });
});

describe("el cuaderno de ranuras", () => {
  it("no pasa los posts por día de una red (el espacio mínimo) ni su tope semanal", () => {
    // X: 3 por semana a las 09:00 y las 18:00 de lunes a viernes: como mucho 1 por día.
    const book = planSlotBook({
      ...bounds("2026-10-26", 7, new Date("2026-10-20T12:00:00Z")),
      cadence: { x: { postsPerWeek: 3, days: [], hours: ["09:00", "18:00"] } },
      planned: [],
    });
    const assigned = [1, 2, 3, 4].map(() => book.assign(["x"]));
    expect(assigned.map((item) => (item === null ? null : formatChileTime(item.slot.at)))).toEqual([
      "2026-10-26 09:00",
      "2026-10-27 09:00",
      "2026-10-28 09:00",
      null,
    ]);
  });

  it("las redes de la idea son las candidatas con esa ranura libre", () => {
    const book = planSlotBook({
      ...bounds("2026-10-26", 7, new Date("2026-10-20T12:00:00Z")),
      cadence: {
        linkedin: { postsPerWeek: 2, days: ["mon"], hours: ["10:00"] },
        x: { postsPerWeek: 2, days: ["mon"], hours: ["10:00"] },
      },
      // LinkedIn ya tiene un post el lunes 26 a las 10:00.
      planned: [{ date: "2026-10-26", time: "10:00", platforms: ["linkedin"] }],
    });
    expect(book.assign(["linkedin", "x"])).toMatchObject({ platforms: ["x"] });
    expect(book.assign(["linkedin", "x"])).toBeNull();
  });
});
