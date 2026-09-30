/** Máximo de niveles al desarmar una celda (una fórmula cuyo resultado es texto enriquecido…). */
const MAX_DEPTH = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !(value instanceof Date);
}

/**
 * Valor de una celda de exceljs → `RawCell` (lo que acepta el validador de F1-T02), cuando se puede:
 * - fórmula (`{ formula | sharedFormula, result }`) → su resultado guardado. Un Excel generado por
 *   script, sin valores calculados, no lo trae: la celda se lee **vacía**;
 * - hipervínculo (`{ text, hyperlink }`) → el texto visible, no la URL. Si en `link_video` el texto
 *   dice "Ver video", el validador lo marca como link inválido;
 * - texto enriquecido (`{ richText: [{ text }] }`) → el texto plano;
 * - las fechas quedan como `Date` (exceljs las entrega en UTC).
 * Lo demás se devuelve tal cual y el validador lo rechaza con `FIELD_VALUE_INVALID`. Incluye los
 * errores de Excel (`{ error: "#REF!" }`), que así no pasan como texto válido en ningún campo.
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
  return value;
}

/**
 * Texto de un encabezado o de una etiqueta (`Campo`), sin espacios en los bordes. Un error de Excel
 * da su texto (`#REF!`), y un objeto que no se sabe leer, vacío.
 */
export function cellText(value: unknown): string {
  const flat = flattenCell(value);
  if (flat === null || flat === undefined) return "";
  if (flat instanceof Date) return flat.toISOString();
  if (isRecord(flat)) return typeof flat.error === "string" ? flat.error : "";
  return String(flat).trim();
}
