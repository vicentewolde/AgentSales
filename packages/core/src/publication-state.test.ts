import { describe, expect, it } from "vitest";
import { PUBLICATION_STATUSES, type PublicationStatus } from "./enums.js";
import { AppError } from "./errors.js";
import { canTransition, PUBLICATION_TRANSITIONS, transition } from "./publication-state.js";

// Copia literal del diagrama de docs/01-arquitectura.md, independiente de la implementación.
const VALID: readonly [PublicationStatus, PublicationStatus][] = [
  ["draft", "pending_approval"],
  ["pending_approval", "approved"],
  ["pending_approval", "draft"],
  ["approved", "scheduled"],
  ["approved", "publishing"],
  ["scheduled", "publishing"],
  ["publishing", "published"],
  ["publishing", "failed"],
  ["publishing", "awaiting_manual_confirm"],
  ["awaiting_manual_confirm", "published"],
  ["awaiting_manual_confirm", "failed"],
  ["failed", "publishing"],
  ["published", "paused"],
  ["published", "unpublished"],
  ["paused", "published"],
  ["paused", "unpublished"],
];

const isValid = (from: PublicationStatus, to: PublicationStatus) =>
  VALID.some(([f, t]) => f === from && t === to);

const INVALID = PUBLICATION_STATUSES.flatMap((from) =>
  PUBLICATION_STATUSES.filter((to) => !isValid(from, to)).map(
    (to) => [from, to] as [PublicationStatus, PublicationStatus],
  ),
);

describe("máquina de estados de una publicación", () => {
  it("cubre la matriz completa: 16 válidas y 84 inválidas", () => {
    expect(VALID).toHaveLength(16);
    expect(INVALID).toHaveLength(PUBLICATION_STATUSES.length ** 2 - 16);
  });

  it.each(VALID)("permite %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(transition(from, to)).toBe(to);
  });

  it.each(INVALID)("rechaza %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);

    let error: unknown;
    try {
      transition(from, to);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "INVALID_TRANSITION",
      retriable: false,
      details: { from, to },
    });
  });

  it("define salidas para todos los estados y unpublished es terminal", () => {
    expect(Object.keys(PUBLICATION_TRANSITIONS).sort()).toEqual([...PUBLICATION_STATUSES].sort());
    expect(PUBLICATION_TRANSITIONS.unpublished).toEqual([]);
  });
});
