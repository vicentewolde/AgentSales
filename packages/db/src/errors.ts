import { AppError, isAppError } from "@agentsales/core";

/** Códigos de red de Node que significan "no se llegó a la base" (o se perdió la conexión). */
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

/**
 * SQLSTATE de "la base no está disponible": `57P01`–`57P03` (apagándose o arrancando; Neon al
 * despertar) y `53300` (demasiadas conexiones). La clase `08` (conexión) también cuenta, salvo
 * `08P01` (violación de protocolo), que es un bug y reintentar no lo arregla.
 */
const UNAVAILABLE_SQLSTATES = new Set(["57P01", "57P02", "57P03", "53300"]);

function isUnavailableSqlState(state: string): boolean {
  return UNAVAILABLE_SQLSTATES.has(state) || (state.startsWith("08") && state !== "08P01");
}

/** Mensajes de pg y pg-pool cuando se cae o no se logra la conexión (no traen `code`). */
const CONNECTION_MESSAGES = [
  "timeout exceeded when trying to connect",
  "Connection terminated",
  "connection timeout",
  "Client has encountered a connection error and is not queryable",
];

/** El error y sus `cause`, en orden: drizzle envuelve el error del driver en `DrizzleQueryError`. */
function* causeChain(error: unknown): Generator<unknown> {
  let current = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    yield current;
    current = current instanceof Error ? current.cause : undefined;
  }
}

function codeOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) return undefined;
  return typeof value.code === "string" ? value.code : undefined;
}

/** Los errores de sistema de Node (`EPIPE`…) traen `syscall`; los de Postgres, no. */
function isSystemError(value: unknown): boolean {
  return typeof value === "object" && value !== null && "syscall" in value;
}

/**
 * El `DrizzleQueryError` lleva el SQL y los parámetros en su mensaje: comparar ese mensaje daría
 * falsos positivos si un dato del usuario dice, por ejemplo, "connection timeout".
 */
function isQueryWrapper(value: unknown): boolean {
  return typeof value === "object" && value !== null && ("query" in value || "params" in value);
}

/** SQLSTATE del error del driver (pg o PGlite), si lo hay; por ejemplo `23505` (único violado). */
export function sqlStateOf(error: unknown): string | undefined {
  for (const value of causeChain(error)) {
    const code = codeOf(value);
    // Los códigos de sistema también pueden tener 5 letras (`EPIPE`).
    if (code !== undefined && !isSystemError(value) && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

/** `true` si el error significa que la base no responde (y reintentar puede funcionar). */
export function isDbUnavailable(error: unknown): boolean {
  // Si Postgres respondió con un SQLSTATE, ese código decide: la base sí está disponible.
  const state = sqlStateOf(error);
  if (state !== undefined) return isUnavailableSqlState(state);
  for (const value of causeChain(error)) {
    const code = codeOf(value);
    if (code !== undefined && NETWORK_CODES.has(code)) return true;
    if (
      value instanceof Error &&
      !isQueryWrapper(value) &&
      CONNECTION_MESSAGES.some((message) => value.message.includes(message))
    ) {
      return true;
    }
  }
  return false;
}

/** Propiedades del error del driver que no traen datos: identifican el problema, no la fila. */
const SAFE_DRIVER_FIELDS = ["code", "constraint", "table", "column", "schema"] as const;

/**
 * Error del driver **sin datos de clientes**, para guardarlo como `cause` (termina en los logs):
 * - el `DrizzleQueryError` lleva el SQL y los parámetros en su mensaje;
 * - el error de pg o PGlite lleva datos en `detail` ("Failing row contains (…)", "Key (…)=(…)") y
 *   a veces en `message` ("invalid input syntax for type numeric: …").
 * Se arma un `Error` nuevo con un mensaje fijo y solo `code`, `constraint`, `table`, `column` y
 * `schema`. `sqlStateOf` lo sigue leyendo porque conserva `code`; un error de red (`ECONNREFUSED`)
 * se describe con su código.
 */
function safeDriverError(error: unknown): Error {
  const driver = isQueryWrapper(error) && error instanceof Error ? error.cause : error;
  const safe = new Error(`Error de la base de datos (${codeOf(driver) ?? "sin código"})`);
  safe.name = "DatabaseDriverError";
  if (typeof driver === "object" && driver !== null) {
    for (const field of SAFE_DRIVER_FIELDS) {
      const value = (driver as Record<string, unknown>)[field];
      if (typeof value === "string") Object.assign(safe, { [field]: value });
    }
  }
  return safe;
}

/**
 * Traduce los errores de la base de datos:
 * - fallo de conexión → `AppError("DB_UNAVAILABLE", { retriable: true })` (la API responde 503 y
 *   el job se reintenta);
 * - otro error de una consulta de drizzle → `AppError("DB_QUERY_FAILED")`, no reintentable, con el
 *   SQLSTATE en `details`;
 * - en los dos casos, `cause` es un resumen del error del driver sin datos (`safeDriverError`).
 * Un `AppError` o un error ajeno a la base se devuelven tal cual.
 */
export function toDbError(error: unknown): unknown {
  if (isAppError(error)) return error;
  if (isDbUnavailable(error)) {
    return new AppError("DB_UNAVAILABLE", "La base de datos no responde", {
      retriable: true,
      cause: safeDriverError(error),
    });
  }
  if (isQueryWrapper(error)) {
    const state = sqlStateOf(error);
    return new AppError("DB_QUERY_FAILED", "Falló una consulta a la base de datos", {
      cause: safeDriverError(error),
      details: state === undefined ? {} : { sqlState: state },
    });
  }
  return error;
}

/** Ejecuta una operación de base de datos y traduce sus errores con `toDbError`. */
export async function withDbErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toDbError(error);
  }
}
