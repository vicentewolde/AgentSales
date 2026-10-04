/**
 * Claves estables para una lista que puede repetir elementos (dos problemas iguales de la
 * revisión): el texto y, si se repite, cuántas veces apareció antes.
 */
export function uniqueKeys<T>(items: readonly T[], keyOf: (item: T) => string): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const key = keyOf(item);
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0 ? key : `${key}#${count}`;
  });
}
