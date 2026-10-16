import { describe, expect, it } from "vitest";
import type { Publication } from "../publication.js";
import { isManualTask, manualTasksOf } from "./manual-tasks.js";

// Spec F6 §4.8 (D4): Instagram y Marketplace en vivo de una propiedad cerrada.

const publication = (overrides: Partial<Publication>) =>
  ({
    id: "p",
    platform: "instagram",
    dryRun: false,
    status: "published",
    ...overrides,
  }) as Publication;

describe("isManualTask", () => {
  it("Instagram o Marketplace publicados en vivo de una propiedad cerrada", () => {
    expect(isManualTask("closed", publication({}))).toBe(true);
    expect(isManualTask("closed", publication({ platform: "fb_marketplace" }))).toBe(true);
  });

  it("no: Portal (se cierra solo), una simulada, una que no está publicada o una propiedad abierta", () => {
    expect(isManualTask("closed", publication({ platform: "portal_inmobiliario" }))).toBe(false);
    expect(isManualTask("closed", publication({ dryRun: true }))).toBe(false);
    expect(isManualTask("closed", publication({ status: "unpublished" }))).toBe(false);
    expect(isManualTask("active", publication({}))).toBe(false);
  });

  it("manualTasksOf filtra en orden", () => {
    const list = [
      publication({ id: "a" }),
      publication({ id: "b", dryRun: true }),
      publication({ id: "c", platform: "fb_marketplace" }),
    ];
    expect(manualTasksOf("closed", list).map((p) => p.id)).toEqual(["a", "c"]);
  });
});
