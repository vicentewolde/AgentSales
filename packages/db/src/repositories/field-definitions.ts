import {
  AppError,
  type FieldDefinition,
  type FieldDefinitionQuery,
  type FieldDefinitionRepository,
  fieldDefinitionSchema,
} from "@agentsales/core";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { withDbErrors } from "../errors.js";
import { fieldDefinitions } from "../schema.js";

type FieldDefinitionRow = typeof fieldDefinitions.$inferSelect;

/**
 * Fila → entidad de core. `options` es jsonb: se valida al leerlo en vez de asumir su forma. Una
 * fila corrupta es `FIELD_DEFINITION_INVALID` (no reintentable), con el `id` y el `key`.
 */
function toFieldDefinition(row: FieldDefinitionRow): FieldDefinition {
  const parsed = fieldDefinitionSchema.safeParse({
    id: row.id,
    brokerId: row.brokerId,
    category: row.category,
    key: row.key,
    label: row.label,
    type: row.type,
    required: row.required,
    options: row.options,
    sourceColumn: row.sourceColumn,
    isCore: row.isCore,
    minValue: row.minValue,
    maxValue: row.maxValue,
    sortOrder: row.sortOrder,
    active: row.active,
  });
  if (!parsed.success) {
    throw new AppError(
      "FIELD_DEFINITION_INVALID",
      `La definición de campo ${row.key} tiene datos inválidos`,
      { details: { id: row.id, key: row.key, issues: parsed.error.issues } },
    );
  }
  return parsed.data;
}

/** `FieldDefinitionRepository` sobre Drizzle (node-postgres en las apps, PGlite en los tests). */
export function createFieldDefinitionRepository(db: SchemaDatabase): FieldDefinitionRepository {
  return {
    list({ category, brokerId }: FieldDefinitionQuery) {
      return withDbErrors(async () => {
        const owner =
          brokerId === null
            ? isNull(fieldDefinitions.brokerId)
            : or(isNull(fieldDefinitions.brokerId), eq(fieldDefinitions.brokerId, brokerId));
        const rows = await db
          .select()
          .from(fieldDefinitions)
          .where(and(eq(fieldDefinitions.category, category), owner))
          // Mismo orden que el repositorio en memoria: `key` byte a byte y la global primero.
          .orderBy(
            asc(fieldDefinitions.sortOrder),
            sql`${fieldDefinitions.key} collate "C"`,
            sql`${fieldDefinitions.brokerId} asc nulls first`,
          );
        return rows.map(toFieldDefinition);
      });
    },
  };
}
