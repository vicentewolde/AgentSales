/** Copia profunda de datos planos (JSON más fechas): lo guardado no se comparte con quien llama. */
export function structuredCopy<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(structuredCopy) as T;
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, structuredCopy(item)]),
  ) as T;
}
