import {
  type Bindings,
  type ChildLoggerOptions,
  type DestinationStream,
  type Level,
  type Logger,
  pino,
} from "pino";

export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /token|secret|password|authorization|key/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Copia `value` reemplazando por `[REDACTED]` toda clave sensible, a cualquier profundidad.
 * Solo recorre objetos planos y arreglos; errores, fechas y otras instancias pasan intactos.
 */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((item) => redact(item, seen));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : redact(item, seen),
    ]),
  );
}

export type LoggerOptions = {
  level?: Level | "silent";
  /** Salida legible con pino-pretty (desarrollo). Se ignora si se pasa `destination`. */
  pretty?: boolean;
  name?: string;
};

type ChildFn = (this: Logger, bindings: Bindings, options?: ChildLoggerOptions) => Logger;

/**
 * pino no pasa los bindings de `child()` por los formatters: se redactan aquí. Basta con
 * parchar la raíz, porque cada hijo hereda de su padre por prototipo y `this` es el hijo.
 */
function redactChildBindings(logger: Logger): Logger {
  // La firma de pino es genérica en niveles personalizados, que este proyecto no usa.
  const baseChild = logger.child as unknown as ChildFn;
  const redactedChild: ChildFn = function (bindings, options) {
    return baseChild.call(this, redact(bindings) as Bindings, options);
  };
  logger.child = redactedChild as unknown as Logger["child"];
  return logger;
}

/**
 * Logger pino con redacción de secretos en los objetos logueados y en los bindings de `child()`.
 * El texto del mensaje no se redacta: nunca interpoles secretos en él.
 */
export function createLogger(options: LoggerOptions = {}, destination?: DestinationStream): Logger {
  const config = {
    level: options.level ?? "info",
    ...(options.name ? { name: options.name } : {}),
    formatters: {
      log: (object: Record<string, unknown>) => redact(object) as Record<string, unknown>,
    },
  };
  if (destination) {
    return redactChildBindings(pino(config, destination));
  }
  if (options.pretty) {
    return redactChildBindings(pino({ ...config, transport: { target: "pino-pretty" } }));
  }
  return redactChildBindings(pino(config));
}
