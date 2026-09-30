import { z } from "zod";
import { FIELD_TYPES } from "./enums.js";

/**
 * Campo configurable de un aviso (ADR-0006, `field_definitions`). `brokerId = null` es una
 * definición global de la categoría; una del corredor con el mismo `key` la sobrescribe.
 */
export const fieldDefinitionSchema = z.object({
  id: z.string(),
  brokerId: z.string().nullable(),
  /** `real_estate` hoy; `product` después. */
  category: z.string().min(1),
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(FIELD_TYPES),
  required: z.boolean(),
  /** Valores permitidos de un `enum`, tal como se escriben en el Excel. */
  options: z.array(z.string()).nullable(),
  /** Encabezado de la columna en el Excel. */
  sourceColumn: z.string().min(1),
  /** Va a una columna fija de `listings` (o controla la carga) en vez de a `attributes`. */
  isCore: z.boolean(),
  sortOrder: z.number().int(),
  active: z.boolean(),
});
export type FieldDefinition = z.infer<typeof fieldDefinitionSchema>;
