/** Máximo de niveles al desarmar una celda (una fórmula cuyo resultado es texto enriquecido…). */
const MAX_DEPTH = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !(value instanceof Date);
}

/**
 * Valor de una celda de exceljs → `RawCell`, lo único que acepta el validador (F1-T02):
 * - fórmula (`{ formula | sharedFormula, result }`) → su resultado;
 * - hipervínculo (`{ text, hyperlink }`) → el texto visible;
 * - texto enriquecido (`{ richText: [{ text }] }`) → el texto plano;
 * - error de Excel (`{ error: "#N/A" }`) → el texto del error, para que el validador lo marque;
 * - las fechas quedan como `Date` (exceljs las entrega en UTC).
 * Cualquier otra forma se devuelve tal cual y el validador la rechaza (`FIELD_VALUE_INVALID`).
 */
export function flattenCell(value: unknown, depth = 0): unknown {
  if (!isRecord(value) || depth >= MAX_DEPTH) return value ?? null;
  if ("formula" in value || "sharedFormula" in value) {
    return "result" in value ? flattenCell(value.result, depth + 1) : null;
  }
  if (Array.isArray(value.richText)) {
    return value.richText
      .map((run: unknown) => (isRecord(run) && typeof run.text === "string" ? run.text : ""))
      .join("");
  }
  if ("hyperlink" in value) {
    return "text" in value ? flattenCell(value.text, depth + 1) : value.hyperlink;
  }
  if (typeof value.error === "string") return value.error;
  return value;
}

/** Texto de un encabezado o de una etiqueta (`Campo`), sin espacios en los bordes. */
export function cellText(value: unknown): string {
  const flat = flattenCell(value);
  if (flat === null || flat === undefined) return "";
  return (flat instanceof Date ? flat.toISOString() : String(flat)).trim();
}
