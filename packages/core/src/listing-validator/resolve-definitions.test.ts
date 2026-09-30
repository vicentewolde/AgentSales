import { describe, expect, it } from "vitest";
import type { FieldDefinition } from "../field-definition.js";
import { resolveEffectiveDefinitions } from "./resolve-definitions.js";

const def = (
  id: string,
  key: string,
  overrides: Partial<FieldDefinition> = {},
): FieldDefinition => ({
  id,
  brokerId: null,
  category: "real_estate",
  key,
  label: key,
  type: "text",
  required: false,
  options: null,
  sourceColumn: key,
  isCore: false,
  sortOrder: 0,
  active: true,
  ...overrides,
});

const ids = (defs: FieldDefinition[]) => defs.map((d) => d.id);

describe("resolveEffectiveDefinitions", () => {
  it("la del corredor gana a la global aunque vaya antes en la lista", () => {
    const result = resolveEffectiveDefinitions([
      def("broker-piso", "piso", { brokerId: "b1", sortOrder: 1 }),
      def("global-banos", "banos", { sortOrder: 5 }),
      def("global-piso", "piso", { sortOrder: 10 }),
    ]);
    expect(ids(result)).toEqual(["broker-piso", "global-banos"]);
  });

  it("una del corredor inactiva desactiva la global", () => {
    const result = resolveEffectiveDefinitions([
      def("global-piso", "piso"),
      def("broker-piso", "piso", { brokerId: "b1", active: false }),
      def("global-banos", "banos"),
    ]);
    expect(ids(result)).toEqual(["global-banos"]);
  });

  it("descarta las globales inactivas sin reemplazo y mantiene el orden de entrada", () => {
    const result = resolveEffectiveDefinitions([
      def("a", "a"),
      def("viejo", "viejo", { active: false }),
      def("b", "b"),
    ]);
    expect(ids(result)).toEqual(["a", "b"]);
  });
});
