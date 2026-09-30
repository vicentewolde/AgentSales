import type { FieldDefinition } from "../field-definition.js";

export type FieldDefinitionQuery = {
  category: string;
  /** Corredor de la carga; `null` devuelve solo las globales. */
  brokerId: string | null;
};

/**
 * Lectura de `field_definitions`. Resolver qué definición gana cuando un `key` se repite (la del
 * corredor sobre la global) es del validador, no del repositorio.
 *
 * Los errores de conexión son `AppError("DB_UNAVAILABLE", { retriable: true })`.
 */
export interface FieldDefinitionRepository {
  /**
   * Definiciones **activas** de la categoría: las globales más las del corredor, ordenadas por
   * `sortOrder`, luego por `key` (byte a byte) y, si el `key` se repite, la global primero.
   */
  list(query: FieldDefinitionQuery): Promise<FieldDefinition[]>;
}
