import { describe, expect, it } from "vitest";
import { isAppError } from "./errors.js";
import { SCHEDULE_OVERDUE_MS, scheduleAt, scheduleState } from "./schedule.js";

const NOW = new Date("2026-10-19T12:00:30.000Z");

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return isAppError(error) ? error.code : "otro";
  }
  return null;
};

describe("scheduleAt", () => {
  it("deja la hora al minuto, sin segundos", () => {
    expect(scheduleAt(new Date("2026-10-19T13:00:59.999Z"), NOW)).toEqual(
      new Date("2026-10-19T13:00:00.000Z"),
    );
  });

  it("exige al menos 2 minutos adelante, contados después de quitar los segundos", () => {
    expect(codeOf(() => scheduleAt(new Date("2026-10-19T12:02:00.000Z"), NOW))).toBe(
      "SCHEDULE_TOO_SOON",
    );
    expect(codeOf(() => scheduleAt(new Date("2026-10-19T12:01:59.000Z"), NOW))).toBe(
      "SCHEDULE_TOO_SOON",
    );
    expect(scheduleAt(new Date("2026-10-19T12:03:00.000Z"), NOW)).toEqual(
      new Date("2026-10-19T12:03:00.000Z"),
    );
    expect(codeOf(() => scheduleAt(new Date("2026-10-18T12:00:00.000Z"), NOW))).toBe(
      "SCHEDULE_TOO_SOON",
    );
  });

  it("como mucho 60 días adelante", () => {
    expect(codeOf(() => scheduleAt(new Date("2026-12-18T12:01:00.000Z"), NOW))).toBe(
      "SCHEDULE_TOO_FAR",
    );
    expect(scheduleAt(new Date("2026-12-18T12:00:00.000Z"), NOW)).toEqual(
      new Date("2026-12-18T12:00:00.000Z"),
    );
  });

  it("una fecha inválida es SCHEDULE_AT_INVALID", () => {
    expect(codeOf(() => scheduleAt(new Date("no"), NOW))).toBe("SCHEDULE_AT_INVALID");
  });

  it("sin margen (el recordatorio de auto_publish) acepta el minuto de ahora", () => {
    expect(scheduleAt(NOW, NOW, { minLead: false })).toEqual(new Date("2026-10-19T12:00:00.000Z"));
    expect(
      codeOf(() => scheduleAt(new Date("2026-10-19T11:58:00.000Z"), NOW, { minLead: false })),
    ).toBe("SCHEDULE_TOO_SOON");
  });
});

describe("scheduleState", () => {
  const at = new Date("2026-10-19T10:00:00.000Z");
  const scheduled = {
    status: "scheduled" as const,
    scheduledAt: at,
    platform: "instagram" as const,
  };

  it("próxima, vencida y atrasada según la hora", () => {
    expect(scheduleState(scheduled, new Date("2026-10-19T09:59:59.000Z"))).toBe("upcoming");
    expect(scheduleState(scheduled, at)).toBe("due");
    expect(scheduleState(scheduled, new Date(at.getTime() + SCHEDULE_OVERDUE_MS))).toBe("due");
    expect(scheduleState(scheduled, new Date(at.getTime() + SCHEDULE_OVERDUE_MS + 1))).toBe(
      "overdue",
    );
  });

  it("un recordatorio de Marketplace nunca está atrasado: te toca", () => {
    expect(
      scheduleState({ ...scheduled, platform: "fb_marketplace" }, new Date("2026-10-25T10:00:00Z")),
    ).toBe("due");
  });

  it("null si no está programada", () => {
    expect(scheduleState({ ...scheduled, status: "approved" }, at)).toBeNull();
    expect(scheduleState({ ...scheduled, scheduledAt: null }, at)).toBeNull();
  });
});
