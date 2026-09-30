import type { FieldType } from "../enums.js";

/** Valor de una celda tal como lo entrega el lector de Excel (F1-T03). */
export type RawCell = string | number | boolean | Date | null | undefined;

/** Valor ya normalizado de un campo. */
export type FieldValue = string | number | boolean | string[];

export const FIELD_ISSUE_CODES = [
  "FIELD_REQUIRED",
  "FIELD_NUMBER_INVALID",
  "FIELD_BOOLEAN_INVALID",
  "FIELD_ENUM_INVALID",
  "FIELD_LIST_INVALID",
  "FIELD_DATE_INVALID",
  "FIELD_URL_INVALID",
  "FIELD_VALUE_INVALID",
] as const;
export type FieldIssueCode = (typeof FIELD_ISSUE_CODES)[number];

export type Normalized<T extends FieldValue = FieldValue> =
  | { ok: true; value: T }
  | { ok: false; code: FieldIssueCode; message: string };

const ok = <T extends FieldValue>(value: T): Normalized<T> => ({ ok: true, value });
const fail = (code: FieldIssueCode, message: string): Normalized<never> => ({
  ok: false,
  code,
  message,
});

/** `true` si la celda está vacía (sin valor o solo espacios). */
export function isBlank(value: RawCell): value is null | undefined | "" {
  return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

/** Para comparar sin mayúsculas, tildes ni espacios extra (`Sí` = `si`, `Ñuñoa` = `nunoa`). */
export function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Fecha de Excel → `dd-mm-aaaa` (como la escribe el operador). Excel guarda fechas sin zona: UTC. */
function formatDayMonthYear(date: Date): string {
  return `${pad(date.getUTCDate())}-${pad(date.getUTCMonth() + 1)}-${date.getUTCFullYear()}`;
}

const quote = (value: RawCell) => `«${String(value).trim()}»`;

export function normalizeText(value: RawCell): Normalized<string> {
  if (value instanceof Date) return ok(formatDayMonthYear(value));
  return ok(String(value).trim());
}

// Miles con punto (`5.800`, `1.234.567`) y, opcional, decimales con coma (`1.234,5`).
const GROUPED_THOUSANDS = /^-?\d{1,3}(\.\d{3})+(,\d+)?$/;
const COMMA_DECIMAL = /^-?\d+,\d+$/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * Números como los escribe un corredor en Chile o como los exporta Google Sheets:
 * `5800`, `5.800`, `5 800`, `$650.000`, `1.234.567,8`, `72,5` y `72.5`.
 * Un punto seguido de exactamente 3 dígitos es separador de miles (`1.500` = 1500).
 */
export function normalizeNumber(value: RawCell): Normalized<number> {
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? ok(value)
      : fail("FIELD_NUMBER_INVALID", "no es un número válido");
  }
  if (typeof value !== "string") {
    return fail("FIELD_NUMBER_INVALID", `${quote(value)} no es un número`);
  }
  const compact = value.trim().replace(/^\$/, "").replace(/\s+/g, "");
  let canonical: string | undefined;
  if (GROUPED_THOUSANDS.test(compact)) {
    canonical = compact.replace(/\./g, "").replace(",", ".");
  } else if (COMMA_DECIMAL.test(compact)) {
    canonical = compact.replace(",", ".");
  } else if (PLAIN_NUMBER.test(compact)) {
    canonical = compact;
  }
  if (canonical === undefined) {
    return fail("FIELD_NUMBER_INVALID", `${quote(value)} no es un número`);
  }
  return ok(Number(canonical));
}

const TRUE_WORDS = new Set(["si", "true", "1"]);
const FALSE_WORDS = new Set(["no", "false", "0"]);

export function normalizeBoolean(value: RawCell): Normalized<boolean> {
  if (typeof value === "boolean") return ok(value);
  const folded = foldText(String(value));
  if (TRUE_WORDS.has(folded)) return ok(true);
  if (FALSE_WORDS.has(folded)) return ok(false);
  return fail("FIELD_BOOLEAN_INVALID", `${quote(value)} no es Sí ni No`);
}

/** Devuelve la opción tal como está escrita en la definición (`venta` → `Venta`). */
function matchOption(value: string, options: readonly string[]): string | undefined {
  const folded = foldText(value);
  return options.find((option) => foldText(option) === folded);
}

export function normalizeEnum(value: RawCell, options: readonly string[]): Normalized<string> {
  const text = normalizeText(value);
  if (!text.ok) return text;
  const match = matchOption(text.value, options);
  return match === undefined
    ? fail("FIELD_ENUM_INVALID", `${quote(value)} no es una opción válida (${options.join(", ")})`)
    : ok(match);
}

/** Texto separado por comas → arreglo. Con `options`, cada elemento debe ser una de ellas. */
export function normalizeList(
  value: RawCell,
  options: readonly string[] | null,
): Normalized<string[]> {
  const text = normalizeText(value);
  if (!text.ok) return text;
  const items = text.value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (options === null) return ok(items);
  const matched: string[] = [];
  const invalid: string[] = [];
  for (const item of items) {
    const match = matchOption(item, options);
    if (match === undefined) invalid.push(item);
    else if (!matched.includes(match)) matched.push(match);
  }
  if (invalid.length > 0) {
    return fail(
      "FIELD_LIST_INVALID",
      `${invalid.map((item) => `«${item}»`).join(", ")} no es una opción válida (${options.join(", ")})`,
    );
  }
  return ok(matched);
}

const DAY_MONTH_YEAR = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isoDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return valid ? `${year}-${pad(month)}-${pad(day)}` : undefined;
}

/** Fecha → ISO `aaaa-mm-dd`. Acepta `dd-mm-aaaa`, `dd/mm/aaaa`, `aaaa-mm-dd` o una fecha de Excel. */
export function normalizeDate(value: RawCell): Normalized<string> {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? fail("FIELD_DATE_INVALID", "no es una fecha válida")
      : ok(value.toISOString().slice(0, 10));
  }
  const text = String(value).trim();
  const dmy = DAY_MONTH_YEAR.exec(text);
  const ymd = ISO_DATE.exec(text);
  const iso = dmy
    ? isoDate(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]))
    : ymd
      ? isoDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]))
      : undefined;
  return iso === undefined
    ? fail("FIELD_DATE_INVALID", `${quote(value)} no es una fecha (dd-mm-aaaa)`)
    : ok(iso);
}

// `core` no tiene el global `URL` (compila sin DOM ni tipos de Node): basta con esquema y host.
const HTTP_URL = /^https?:\/\/[^\s/?#]+\.[^\s/?#]+([/?#]\S*)?$/i;

export function normalizeUrl(value: RawCell): Normalized<string> {
  const text = String(value).trim();
  return HTTP_URL.test(text)
    ? ok(text)
    : fail("FIELD_URL_INVALID", `${quote(value)} no es un link (http o https)`);
}

/** Normaliza una celda **no vacía** según el tipo de su definición. */
export function normalizeField(
  type: FieldType,
  value: RawCell,
  options: readonly string[] | null,
): Normalized {
  switch (type) {
    case "text":
      return normalizeText(value);
    case "number":
      return normalizeNumber(value);
    case "boolean":
      return normalizeBoolean(value);
    case "enum":
      return normalizeEnum(value, options ?? []);
    case "list":
      return normalizeList(value, options);
    case "date":
      return normalizeDate(value);
    case "url":
      return normalizeUrl(value);
  }
}
