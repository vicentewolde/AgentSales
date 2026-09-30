import { describe, expect, it } from "vitest";
import { fieldDefinitionOrderFixture } from "./field-definition-fixtures.js";
import { createInMemoryFieldDefinitionRepository } from "./field-definition-repository.js";

const fixture = fieldDefinitionOrderFixture({ brokerA: "broker-a", brokerB: "broker-b" });
const repo = createInMemoryFieldDefinitionRepository(
  fixture.rows.map((row) => ({ ...row, id: row.label })),
);
const labels = (rows: { label: string }[]) => rows.map((row) => row.label);

// Mismo fixture que los tests del repositorio Drizzle (packages/db/test), para que ordenen igual.
describe("createInMemoryFieldDefinitionRepository", () => {
  it("sin corredor devuelve las globales de la categoría (incluidas las inactivas), en orden", async () => {
    const result = await repo.list({ category: fixture.category, brokerId: null });
    expect(labels(result)).toEqual(fixture.expected.global);
  });

  it("con corredor suma las suyas, con la global primero si el key se repite", async () => {
    const result = await repo.list({ category: fixture.category, brokerId: "broker-a" });
    expect(labels(result)).toEqual(fixture.expected.brokerA);
  });

  it("devuelve copias profundas: modificar el resultado no cambia lo guardado", async () => {
    const [base] = fixture.rows;
    if (!base) throw new Error("el fixture no tiene filas");
    const withOptions = createInMemoryFieldDefinitionRepository([
      { ...base, id: "1", type: "enum", options: ["Sí", "No"] },
    ]);
    const [first] = await withOptions.list({ category: fixture.category, brokerId: null });
    first?.options?.push("Tal vez");
    const [again] = await withOptions.list({ category: fixture.category, brokerId: null });
    expect(again?.options).toEqual(["Sí", "No"]);
  });
});
