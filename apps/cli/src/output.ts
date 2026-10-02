import { ApiCallError, apiHint } from "./api-client.js";
import type { Colors } from "./colors.js";

/** Salida de un comando: inyectada para que los tests la lean. Los fallos van a `printError`. */
export type Io = {
  print: (text: string) => void;
  printError: (text: string) => void;
  colors: Colors;
};

/** Error detectado por la CLI antes de llamar a la API (una ruta que no existe, un `--broker` vacío…). */
export class CliError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.hint = hint;
  }
}

/** Qué hacer ante los errores de la API que tienen arreglo del lado del operador. */
const API_HINTS: Readonly<Record<string, string>> = {
  DB_UNAVAILABLE: "Neon puede estar despertando: reintenta en unos segundos",
  QUEUE_UNAVAILABLE: "Arranca el worker (pnpm dev) y reintenta",
  STORAGE_UNAVAILABLE: "Revisa las variables R2_* y corre pnpm storage:check",
  HOST_NOT_ALLOWED: apiHint(new ApiCallError("", "HOST_NOT_ALLOWED")),
  UNEXPECTED_RESPONSE: apiHint(new ApiCallError("", "UNEXPECTED_RESPONSE")),
};

/**
 * Un fallo esperable, como `CODE: mensaje` y una sugerencia, sin stack trace (spec F1 §4.7).
 * Devuelve `null` si no es de la CLI ni de la API: ese es un bug y sigue su curso.
 */
export function renderFailure(error: unknown, c: Colors): string | null {
  const hintLine = (hint: string | undefined) => (hint ? [`  ${c.dim(`→ ${hint}`)}`] : []);
  if (error instanceof CliError) {
    return [c.red(`✗ ${error.code}: ${error.message}`), ...hintLine(error.hint)].join("\n");
  }
  if (error instanceof ApiCallError) {
    if (error.status === undefined) {
      return [c.red(`✗ La API no responde: ${error.message}`), ...hintLine(apiHint(error))].join(
        "\n",
      );
    }
    const hint = error.code === undefined ? undefined : API_HINTS[error.code];
    return [c.red(`✗ ${error.message}`), ...hintLine(hint)].join("\n");
  }
  return null;
}

/** Corre el cuerpo de un comando: un fallo esperable se muestra y sale con 1. */
export async function guarded(io: Io, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (error) {
    const text = renderFailure(error, io.colors);
    if (text === null) throw error;
    io.printError(text);
    return 1;
  }
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const visibleLength = (text: string) => text.replace(ANSI, "").length;

/** Tabla de texto alineada; la última columna no se rellena (suele ser el motivo, largo). */
export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  c: Colors,
) {
  const widths = headers.map((header, column) =>
    Math.max(visibleLength(header), ...rows.map((row) => visibleLength(row[column] ?? ""))),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) =>
        column === cells.length - 1
          ? cell
          : cell + " ".repeat((widths[column] ?? 0) - visibleLength(cell)),
      )
      .join("  ")
      .trimEnd();
  return [c.bold(line(headers)), ...rows.map(line)].join("\n");
}

/** `1,2 MB`, con coma decimal. */
export function formatBytes(bytes: number): string {
  const units = ["kB", "MB", "GB"];
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(1).replace(".", ",")} ${unit}`;
}

/** `2026-10-02 14:05`, en la hora local del operador. */
export function formatDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
