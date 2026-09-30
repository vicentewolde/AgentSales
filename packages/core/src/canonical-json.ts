/**
 * JSON con las claves de los objetos ordenadas, en todos los niveles: el mismo dato siempre da el
 * mismo texto, sin importar el orden en que se armó. Base del `source_hash` de la importación. Los
 * arreglos mantienen su orden, porque es parte del dato (las listas del Excel).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}
