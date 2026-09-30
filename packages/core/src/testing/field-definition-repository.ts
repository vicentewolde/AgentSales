import type { FieldDefinition } from "../field-definition.js";
import type {
  FieldDefinitionQuery,
  FieldDefinitionRepository,
} from "../ports/field-definition-repository.js";

/**
 * Orden del puerto: `sortOrder`, luego `key` y, si el `key` se repite, la global primero. `<`
 * compara unidades UTF-16 y `COLLATE "C"` compara bytes UTF-8: coinciden salvo con caracteres
 * fuera del plano básico (emojis), que no se usan en los `key`.
 */
function compareFieldDefinitions(a: FieldDefinition, b: FieldDefinition): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  if (a.brokerId === b.brokerId) return 0;
  return a.brokerId === null ? -1 : 1;
}

/** Copia profunda: `options` es el único campo anidado de la entidad. */
const copy = (row: FieldDefinition): FieldDefinition => ({
  ...row,
  options: row.options === null ? null : [...row.options],
});

/** `FieldDefinitionRepository` en memoria para tests, con la misma semántica que el de Drizzle. */
export function createInMemoryFieldDefinitionRepository(
  rows: readonly FieldDefinition[] = [],
): FieldDefinitionRepository {
  const stored = rows.map(copy);
  return {
    async list({ category, brokerId }: FieldDefinitionQuery) {
      return stored
        .filter(
          (row) =>
            row.category === category && (row.brokerId === null || row.brokerId === brokerId),
        )
        .sort(compareFieldDefinitions)
        .map(copy);
    },
  };
}
