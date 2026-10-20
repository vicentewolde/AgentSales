import { describe, expect, it } from "vitest";
import { PUBLICATION_STATUSES, type PublicationStatus } from "./enums.js";
import { AppError } from "./errors.js";
import {
  ACTIVE_PUBLICATION_STATUSES,
  canTransition,
  INITIAL_PUBLICATION_STATUSES,
  PENDING_PUBLICATION_STATUSES,
  PUBLICATION_TRANSITIONS,
  TERMINAL_PUBLICATION_STATUSES,
  transition,
} from "./publication-state.js";

// Copia literal del diagrama de docs/01-arquitectura.md (ADR-0014, ADR-0018 y, desde F9, ADR-0029:
// `outcome_unknown`), independiente de la implementación.
const STATUSES: readonly PublicationStatus[] = [
  "approved",
  "scheduled",
  "publishing",
  "awaiting_manual_confirm",
  "published",
  "failed",
  "paused",
  "unpublished",
  "cancelled",
  "outcome_unknown",
];

const VALID: readonly [PublicationStatus, PublicationStatus][] = [
  ["approved", "scheduled"],
  ["approved", "publishing"],
  ["approved", "cancelled"],
  ["scheduled", "publishing"],
  ["scheduled", "approved"],
  ["scheduled", "failed"],
  ["scheduled", "cancelled"],
  ["publishing", "published"],
  ["publishing", "failed"],
  ["publishing", "awaiting_manual_confirm"],
  ["publishing", "scheduled"],
  ["publishing", "outcome_unknown"],
  ["awaiting_manual_confirm", "published"],
  ["awaiting_manual_confirm", "failed"],
  ["awaiting_manual_confirm", "cancelled"],
  ["failed", "publishing"],
  ["failed", "scheduled"],
  ["failed", "cancelled"],
  ["published", "paused"],
  ["published", "unpublished"],
  ["paused", "published"],
  ["paused", "unpublished"],
  ["outcome_unknown", "published"],
  ["outcome_unknown", "failed"],
];

const isValid = (from: PublicationStatus, to: PublicationStatus) =>
  VALID.some(([f, t]) => f === from && t === to);

const INVALID = STATUSES.flatMap((from) =>
  STATUSES.filter((to) => !isValid(from, to)).map(
    (to) => [from, to] as [PublicationStatus, PublicationStatus],
  ),
);

describe("máquina de estados de una publicación", () => {
  it("usa exactamente los 10 estados del diagrama (sin draft ni pending_approval)", () => {
    expect(PUBLICATION_STATUSES).toEqual(STATUSES);
    expect(Object.keys(PUBLICATION_TRANSITIONS).sort()).toEqual([...STATUSES].sort());
  });

  it("cubre la matriz completa de 100 pares: 24 válidos y 76 inválidos", () => {
    expect(VALID).toHaveLength(24);
    expect(INVALID).toHaveLength(76);
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

  it("activa es todo estado no terminal, incluidos failed y outcome_unknown", () => {
    expect(ACTIVE_PUBLICATION_STATUSES).toEqual(
      STATUSES.filter((status) => status !== "unpublished" && status !== "cancelled"),
    );
    expect(ACTIVE_PUBLICATION_STATUSES).toContain("failed");
    expect(ACTIVE_PUBLICATION_STATUSES).toContain("outcome_unknown");
  });

  it("el resultado dudoso: publishing → outcome_unknown → published | failed (ADR-0029)", () => {
    expect(transition("publishing", "outcome_unknown")).toBe("outcome_unknown");
    expect(PUBLICATION_TRANSITIONS.outcome_unknown).toEqual(["published", "failed"]);
    // Solo se llega desde un intento en curso; no se reintenta ni se descarta sin resolverla.
    expect(STATUSES.filter((status) => canTransition(status, "outcome_unknown"))).toEqual([
      "publishing",
    ]);
    expect(canTransition("outcome_unknown", "publishing")).toBe(false);
    expect(canTransition("outcome_unknown", "cancelled")).toBe(false);
  });

  it("solo nace en approved, desde el texto aprobado (ADR-0014)", () => {
    expect(INITIAL_PUBLICATION_STATUSES).toEqual(["approved"]);
  });

  it("pendientes son las activas que aún no están en la plataforma", () => {
    expect(PENDING_PUBLICATION_STATUSES).toEqual([
      "approved",
      "scheduled",
      "publishing",
      "failed",
      "awaiting_manual_confirm",
      "outcome_unknown",
    ]);
    expect(
      ACTIVE_PUBLICATION_STATUSES.filter(
        (status) => !(PENDING_PUBLICATION_STATUSES as readonly string[]).includes(status),
      ),
    ).toEqual(["published", "paused"]);
  });

  it("solo lo que no llegó a la plataforma se puede cancelar", () => {
    const cancellable = STATUSES.filter((status) => canTransition(status, "cancelled"));

    expect(cancellable).toEqual(["approved", "scheduled", "awaiting_manual_confirm", "failed"]);
  });
});
