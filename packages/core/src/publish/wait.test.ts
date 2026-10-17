import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import type { PublicationEvent } from "../publication.js";
import {
  consecutiveLimitWaits,
  MAX_LIMIT_WAIT_MINUTES,
  retryAtAfter,
  waitMinutesOf,
} from "./wait.js";

const event = (overrides: Partial<PublicationEvent>): PublicationEvent => ({
  id: "e",
  publicationId: "p",
  type: "status_changed",
  fromStatus: "publishing",
  toStatus: "scheduled",
  actor: "system",
  userId: null,
  payload: { reason: "rate_limit" },
  createdAt: new Date("2026-10-19T12:00:00Z"),
  ...overrides,
});

describe("waitMinutesOf", () => {
  it("lee la señal genérica, la sube al minuto y la acorta a 24 h", () => {
    const wait = (waitMinutes: unknown) =>
      waitMinutesOf(new AppError("X", "x", { details: { waitMinutes } }));
    expect(wait(30)).toBe(30);
    expect(wait(29.2)).toBe(30);
    expect(wait(5000)).toBe(MAX_LIMIT_WAIT_MINUTES);
    expect(wait(0)).toBeNull();
    expect(wait(-5)).toBeNull();
    expect(wait("30")).toBeNull();
    expect(waitMinutesOf(new AppError("X", "x"))).toBeNull();
  });
});

describe("retryAtAfter", () => {
  it("suma la espera y sube al minuto siguiente", () => {
    expect(retryAtAfter(new Date("2026-10-19T15:00:20Z"), 30)).toEqual(
      new Date("2026-10-19T15:31:00Z"),
    );
    expect(retryAtAfter(new Date("2026-10-19T15:00:00Z"), 30)).toEqual(
      new Date("2026-10-19T15:30:00Z"),
    );
  });
});

describe("consecutiveLimitWaits", () => {
  it("cuenta los pasos a scheduled por un límite desde el último paso del operador", () => {
    const events = [
      event({ actor: "operator", type: "status_changed", toStatus: "approved", payload: {} }),
      event({}),
      event({ type: "publish_attempt", toStatus: null, payload: { result: "rescheduled" } }),
      event({ toStatus: "publishing", payload: {} }),
      event({}),
      event({ actor: "cli", toStatus: "publishing", payload: {} }),
      event({}),
      event({ toStatus: "publishing", payload: {} }),
    ];
    expect(consecutiveLimitWaits(events)).toBe(1);
    expect(consecutiveLimitWaits(events.slice(0, 5))).toBe(2);
    // Programar por el operador (otro motivo) no cuenta como espera.
    expect(consecutiveLimitWaits([event({ payload: { reason: "operator" } })])).toBe(0);
    expect(consecutiveLimitWaits([])).toBe(0);
  });
});
