import { formatNumber } from "./price.js";

/** Un atributo listo para mostrar (CLI y panel). */
export type AttributeEntry = {
  key: string;
  label: string;
  value: string;
  /** Columna desconocida del Excel, guardada en `attributes._extra`. */
  extra: boolean;
};

const textOf = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (typeof value === "number") return formatNumber(value);
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.map(textOf).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Los atributos de un aviso (ADR-0006) como texto: primero los que tienen definición, en su orden
 * y con su etiqueta; después los que no (con la clave como etiqueta), y al final las columnas
 * desconocidas de `_extra`. `Sí`/`No`, listas con coma y números con formato chileno.
 */
export function describeAttributes(
  attributes: Readonly<Record<string, unknown>>,
  fields: readonly { key: string; label: string }[],
): AttributeEntry[] {
  const labeled = fields.filter((field) => Object.hasOwn(attributes, field.key));
  const known = new Set(labeled.map((field) => field.key));
  const entry = (key: string, label: string, value: unknown, extra = false): AttributeEntry => ({
    key,
    label,
    value: textOf(value),
    extra,
  });
  const extra = attributes._extra;
  return [
    ...labeled.map((field) => entry(field.key, field.label, attributes[field.key])),
    ...Object.entries(attributes)
      .filter(([key]) => !known.has(key) && key !== "_extra")
      .map(([key, value]) => entry(key, key, value)),
    ...(isRecord(extra)
      ? Object.entries(extra).map(([key, value]) => entry(key, key, value, true))
      : extra === undefined
        ? []
        : [entry("_extra", "_extra", extra)]),
  ];
}
