import type { FieldDefinition } from "../field-definition.js";
import type {
  FieldDefinitionQuery,
  FieldDefinitionRepository,
} from "../ports/field-definition-repository.js";

/** Orden del puerto: `sortOrder`, luego `key` (byte a byte, como `COLLATE "C"`), y la global primero. */
function compareFieldDefinitions(a: FieldDefinition, b: FieldDefinition): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  if (a.brokerId === b.brokerId) return 0;
  return a.brokerId === null ? -1 : 1;
}

/** `FieldDefinitionRepository` en memoria para tests, con la misma semántica que el de Drizzle. */
export function createInMemoryFieldDefinitionRepository(
  rows: readonly FieldDefinition[] = [],
): FieldDefinitionRepository {
  const stored = rows.map((row) => ({ ...row }));
  return {
    async list({ category, brokerId }: FieldDefinitionQuery) {
      return stored
        .filter(
          (row) =>
            row.active &&
            row.category === category &&
            (row.brokerId === null || row.brokerId === brokerId),
        )
        .sort(compareFieldDefinitions)
        .map((row) => ({ ...row }));
    },
  };
}
