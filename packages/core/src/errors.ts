export type AppErrorOptions = {
  /** Si reintentar la operación puede funcionar (por ejemplo, un límite de tasa). */
  retriable?: boolean;
  /** Datos para diagnosticar. Nunca secretos: puede terminar en logs y respuestas HTTP. */
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
