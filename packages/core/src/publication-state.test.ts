import { describe, expect, it } from "vitest";
import { PUBLICATION_STATUSES, type PublicationStatus } from "./enums.js";
import { AppError } from "./errors.js";
import {
  ACTIVE_PUBLICATION_STATUSES,
  canTransition,
  INITIAL_PUBLICATION_STATUSES,
  PUBLICATION_TRANSITIONS,
  TERMINAL_PUBLICATION_STATUSES,
  transition,
} from "./publication-state.js";

// Copia literal del diagrama de docs/01-arquitectura.md, independiente de la implementación.
const STATUSES: readonly PublicationStatus[] = [
  "draft",
  "pending_approval",
  "approved",
  "scheduled",
  "publishing",
  "awaiting_manual_confirm",
  "published",
  "failed",
  "paused",
  "unpublished",
  "cancelled",
];

const VALID: readonly [PublicationStatus, PublicationStatus][] = [
  ["draft", "pending_approval"],
  ["draft", "cancelled"],
  ["pending_approval", "approved"],
  ["pending_approval", "draft"],
  ["pending_approval", "cancelled"],
  ["approved", "scheduled"],
  ["approved", "publishing"],
  ["approved", "cancelled"],
  ["scheduled", "publishing"],
  ["scheduled", "cancelled"],
  ["publishing", "published"],
  ["publishing", "failed"],
  ["publishing", "awaiting_manual_confirm"],
  ["awaiting_manual_confirm", "published"],
  ["awaiting_manual_confirm", "failed"],
  ["awaiting_manual_confirm", "cancelled"],
  ["failed", "publishing"],
  ["failed", "cancelled"],
  ["published", "paused"],
  ["published", "unpublished"],
  ["paused", "published"],
  ["paused", "unpublished"],
];

const isValid = (from: PublicationStatus, to: PublicationStatus) =>
  VALID.some(([f, t]) => f === from && t === to);

const INVALID = STATUSES.flatMap((from) =>
  STATUSES.filter((to) => !isValid(from, to)).map(
    (to) => [from, to] as [PublicationStatus, PublicationStatus],
  ),
);

describe("máquina de estados de una publicación", () => {
  it("usa exactamente los 11 estados del diagrama", () => {
    expect(PUBLICATION_STATUSES).toEqual(STATUSES);
    expect(Object.keys(PUBLICATION_TRANSITIONS).sort()).toEqual([...STATUSES].sort());
  });

  it("cubre la matriz completa de 121 pares: 22 válidos y 99 inválidos", () => {
    expect(VALID).toHaveLength(22);
    expect(INVALID).toHaveLength(99);
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

  it("los terminales son unpublished y cancelled, y no tienen salidas", () => {
    expect(TERMINAL_PUBLICATION_STATUSES).toEqual(["unpublished", "cancelled"]);
    expect(STATUSES.filter((status) => PUBLICATION_TRANSITIONS[status].length === 0)).toEqual([
      "unpublished",
      "cancelled",
    ]);
  });

  it("activa es todo estado no terminal, incluido failed", () => {
    expect(ACTIVE_PUBLICATION_STATUSES).toEqual(
      STATUSES.filter((status) => status !== "unpublished" && status !== "cancelled"),
    );
    expect(ACTIVE_PUBLICATION_STATUSES).toContain("failed");
  });

  it("se crea en draft, pending_approval o approved (auto_publish)", () => {
    expect(INITIAL_PUBLICATION_STATUSES).toEqual(["draft", "pending_approval", "approved"]);
  });

  it("solo lo que no llegó a la plataforma se puede cancelar", () => {
    const cancellable = STATUSES.filter((status) => canTransition(status, "cancelled"));

    expect(cancellable).toEqual([
      "draft",
      "pending_approval",
      "approved",
      "scheduled",
      "awaiting_manual_confirm",
      "failed",
    ]);
  });
});
