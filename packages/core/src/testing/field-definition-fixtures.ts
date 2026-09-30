import type { FieldDefinition } from "../field-definition.js";

/** Definición sin `id`, para insertar igual en memoria y en Postgres. */
export type FieldDefinitionFixtureRow = Omit<FieldDefinition, "id">;

export type FieldDefinitionOrderFixture = {
  category: string;
  rows: FieldDefinitionFixtureRow[];
  /** `label` de las filas que `list` debe devolver, en orden, sin corredor y con `brokerA`. */
  expected: { global: string[]; brokerA: string[] };
};

/**
 * Casos que ambos repositorios (memoria y Drizzle) deben ordenar igual: el mismo `sortOrder` con
 * `key` que distinguen `COLLATE "C"` de una collation de idioma (`B` < `a` < `b` < `á`), un `key`
 * repetido entre la global y el corredor, una inactiva (se devuelve igual), otra categoría y otro
 * corredor (no se devuelven). El `label` identifica cada fila.
 */
export function fieldDefinitionOrderFixture(ids: {
  brokerA: string;
  brokerB: string;
}): FieldDefinitionOrderFixture {
  const category = "fixture_order";
  const row = (
    label: string,
    key: string,
    sortOrder: number,
    overrides: Partial<FieldDefinitionFixtureRow> = {},
  ): FieldDefinitionFixtureRow => ({
    brokerId: null,
    category,
    key,
    label,
    type: "text",
    required: false,
    options: null,
    sourceColumn: key,
    isCore: false,
    sortOrder,
    active: true,
    ...overrides,
  });
  return {
    category,
    rows: [
      row("g-b", "b", 10),
      row("g-á", "á", 10),
      row("a-a", "a", 10, { brokerId: ids.brokerA, required: true }),
      row("g-B", "B", 10),
      row("g-a", "a", 10),
      row("g-off", "off", 20, { active: false }),
      row("a-z", "z", 5, { brokerId: ids.brokerA }),
      row("b-x", "x", 1, { brokerId: ids.brokerB }),
      row("otra", "a", 0, { category: "fixture_other" }),
    ],
    expected: {
      global: ["g-B", "g-a", "g-b", "g-á", "g-off"],
      brokerA: ["a-z", "g-B", "g-a", "a-a", "g-b", "g-á", "g-off"],
    },
  };
}
