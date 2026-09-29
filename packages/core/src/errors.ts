export type AppErrorOptions = {
  /** Si reintentar la operación puede funcionar (por ejemplo, un límite de tasa). */
  retriable?: boolean;
  /** Datos para diagnosticar. Nunca secretos: va a los logs (redactados); la API no lo expone tal cual. */
  details?: Record<string, unknown>;
  cause?: unknown;
};

/**
 * Error tipado del dominio. `code` va en mayúsculas (`IMPORT_INVALID_ROW`,
 * `PUBLISH_RATE_LIMITED`); la API lo traduce a un status HTTP.
 */
export class AppError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string = code, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.retriable = options.retriable ?? false;
    this.details = options.details;
  }
}

/**
 * `true` si `value` es un `AppError`. No depende solo de `instanceof`: si un runner arranca sin
 * la condición `@agentsales/source` puede haber dos copias de la clase (src y dist; ADR-0010).
 */
export function isAppError(value: unknown): value is AppError {
  if (value instanceof AppError) {
    return true;
  }
  return (
    value instanceof Error &&
    value.name === "AppError" &&
    "code" in value &&
    typeof value.code === "string" &&
    "retriable" in value &&
    typeof value.retriable === "boolean"
  );
}
