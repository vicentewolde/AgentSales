import { describe, expect, it } from "vitest";
import type { FieldDefinition } from "../field-definition.js";
import { createInMemoryFieldDefinitionRepository } from "./field-definition-repository.js";

const def = (overrides: Partial<FieldDefinition>): FieldDefinition => ({
  id: overrides.key ?? "id",
  brokerId: null,
  category: "real_estate",
  key: "dormitorios",
  label: "Dormitorios",
  type: "number",
  required: false,
  options: null,
  sourceColumn: overrides.key ?? "dormitorios",
  isCore: false,
  sortOrder: 0,
  active: true,
  ...overrides,
});

describe("createInMemoryFieldDefinitionRepository", () => {
  const rows = [
    def({ id: "g-banos", key: "banos", sortOrder: 20 }),
    def({ id: "g-dorm", key: "dormitorios", sortOrder: 10 }),
    def({ id: "b1-dorm", key: "dormitorios", sortOrder: 10, brokerId: "b1", required: true }),
    def({ id: "b2-piso", key: "piso", sortOrder: 5, brokerId: "b2" }),
    def({ id: "g-old", key: "antiguo", sortOrder: 1, active: false }),
    def({ id: "p-color", key: "color", category: "product" }),
  ];
  const repo = createInMemoryFieldDefinitionRepository(rows);

  it("devuelve las globales activas de la categoría cuando no hay corredor", async () => {
    const result = await repo.list({ category: "real_estate", brokerId: null });
    expect(result.map((row) => row.id)).toEqual(["g-dorm", "g-banos"]);
  });

  it("suma las del corredor (con la global primero si el key se repite) y no las de otro", async () => {
    const result = await repo.list({ category: "real_estate", brokerId: "b1" });
    expect(result.map((row) => row.id)).toEqual(["g-dorm", "b1-dorm", "g-banos"]);
  });

  it("devuelve copias: modificar el resultado no cambia lo guardado", async () => {
    const [first] = await repo.list({ category: "real_estate", brokerId: null });
    if (first) first.label = "cambiado";
    const [again] = await repo.list({ category: "real_estate", brokerId: null });
    expect(again?.label).toBe("Dormitorios");
  });
});
