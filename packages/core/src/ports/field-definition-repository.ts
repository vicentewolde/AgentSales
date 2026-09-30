import type { FieldDefinition } from "../field-definition.js";

export type FieldDefinitionQuery = {
  category: string;
  /** Corredor de la carga; `null` devuelve solo las globales. */
  brokerId: string | null;
};

/**
 * Lectura de `field_definitions`. Resolver las definiciones efectivas es del validador (F1-T02),
 * no del repositorio:
 * - **Precedencia:** con el mismo `key`, gana la del corredor (`brokerId !== null`) sobre la
 *   global, por su dueño y no por su posición en la lista.
 * - **Activas:** el filtro de `active` va **después** de la precedencia. Así un corredor puede
 *   desactivar un campo global con una definición propia `active = false`.
 *
 * Los errores de conexión son `AppError("DB_UNAVAILABLE", { retriable: true })`.
 */
export interface FieldDefinitionRepository {
  /**
   * Definiciones de la categoría, activas e inactivas: las globales más las del corredor. Orden
   * estable: `sortOrder`, luego `key` byte a byte (`COLLATE "C"`) y, si el `key` se repite, la
   * global primero.
   */
  list(query: FieldDefinitionQuery): Promise<FieldDefinition[]>;
}
