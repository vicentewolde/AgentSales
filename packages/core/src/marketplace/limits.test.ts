import { describe, expect, it } from "vitest";
import { dateIn, requiresManualConfirm, startOfDayIn } from "./limits.js";

const TZ = "America/Santiago";

describe("límites de Marketplace", () => {
  it("solo Marketplace deja el clic final al operador", () => {
    expect(requiresManualConfirm("fb_marketplace")).toBe(true);
    expect(requiresManualConfirm("instagram")).toBe(false);
    expect(requiresManualConfirm("portal_inmobiliario")).toBe(false);
  });

  it.each([
    // Octubre: horario de verano (UTC-3).
    ["2026-10-09T18:00:00Z", "2026-10-09", "2026-10-09T03:00:00.000Z"],
    // Las 23:00 del 8 en Santiago todavía son el 8.
    ["2026-10-09T02:00:00Z", "2026-10-08", "2026-10-08T03:00:00.000Z"],
    // Junio: horario de invierno (UTC-4).
    ["2026-06-15T12:00:00Z", "2026-06-15", "2026-06-15T04:00:00.000Z"],
  ])("en %s el día de Santiago es %s y empieza en %s", (now, day, start) => {
    expect(dateIn(TZ, new Date(now))).toBe(day);
    expect(startOfDayIn(TZ, new Date(now)).toISOString()).toBe(start);
  });

  it("el día en que la medianoche no existe (empieza el horario de verano) empieza a la 01:00", () => {
    // 2026-09-06: en Chile los relojes saltan de 00:00 a 01:00 (UTC-4 → UTC-3).
    const start = startOfDayIn(TZ, new Date("2026-09-06T15:00:00Z"));
    expect(dateIn(TZ, start)).toBe("2026-09-06");
    expect(dateIn(TZ, new Date(start.getTime() - 1))).toBe("2026-09-05");
  });
});
