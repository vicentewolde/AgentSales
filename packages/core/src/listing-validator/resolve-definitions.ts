import type { FieldDefinition } from "../field-definition.js";

/**
 * Definiciones efectivas para una carga (ADR-0006), a partir de lo que devuelve
 * `FieldDefinitionRepository.list` (activas e inactivas, globales y del corredor):
 * 1. Con el mismo `key`, gana la del corredor (`brokerId !== null`) sobre la global, por su dueño y
 *    no por su posición en la lista.
 * 2. Después se descartan las inactivas: una definición del corredor con `active = false`
 *    desactiva el campo global.
 *
 * Mantiene el orden de entrada (el del repositorio: `sortOrder`, luego `key`).
 */
export function resolveEffectiveDefinitions(defs: readonly FieldDefinition[]): FieldDefinition[] {
  const winners = new Map<string, FieldDefinition>();
  for (const def of defs) {
    const current = winners.get(def.key);
    if (current === undefined || (current.brokerId === null && def.brokerId !== null)) {
      winners.set(def.key, def);
    }
  }
  return defs.filter((def) => winners.get(def.key) === def && def.active);
}
