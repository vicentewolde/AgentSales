import { AppError, isAppError } from "@agentsales/core";

/** Códigos de red de Node que significan "no se llegó a la base". */
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/**
 * SQLSTATE de "la base no está disponible": clase 08 (conexión), `57P01`–`57P03` (apagándose o
 * arrancando; Neon al despertar) y `53300` (demasiadas conexiones).
 */
const UNAVAILABLE_SQLSTATES = new Set(["57P01", "57P02", "57P03", "53300"]);

/** Mensajes de pg y pg-pool cuando se cae o no se logra la conexión (no traen `code`). */
const CONNECTION_MESSAGES = [
  "timeout exceeded when trying to connect",
  "Connection terminated",
  "connection timeout",
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

/** SQLSTATE del error del driver (pg o PGlite), si lo hay; por ejemplo `23505` (único violado). */
export function sqlStateOf(error: unknown): string | undefined {
  for (const value of causeChain(error)) {
    const code = codeOf(value);
    // Los errores de sistema de Node (`EPIPE`…) también tienen 5 letras, pero traen `syscall`.
    const isSystemError = typeof value === "object" && value !== null && "syscall" in value;
    if (code !== undefined && !isSystemError && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

/** `true` si el error significa que la base no responde (y reintentar puede funcionar). */
export function isDbUnavailable(error: unknown): boolean {
  for (const value of causeChain(error)) {
    const code = codeOf(value);
    if (code !== undefined) {
      if (NETWORK_CODES.has(code) || UNAVAILABLE_SQLSTATES.has(code) || code.startsWith("08")) {
        return true;
      }
    }
    if (value instanceof Error && CONNECTION_MESSAGES.some((m) => value.message.includes(m))) {
      return true;
    }
  }
  return false;
}

/**
 * Traduce un fallo de conexión a `AppError("DB_UNAVAILABLE", { retriable: true })` (la API lo
 * responde como 503 y el job se reintenta). Cualquier otro error se devuelve tal cual.
 */
export function toDbError(error: unknown): unknown {
  if (isAppError(error) || !isDbUnavailable(error)) return error;
  return new AppError("DB_UNAVAILABLE", "La base de datos no responde", {
    retriable: true,
    cause: error,
  });
}

/** Ejecuta una operación de base de datos y traduce sus errores con `toDbError`. */
export async function withDbErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toDbError(error);
  }
}
