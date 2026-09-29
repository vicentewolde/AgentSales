import { fileURLToPath } from "node:url";
import {
  type Bindings,
  type ChildLoggerOptions,
  type DestinationStream,
  type LevelWithSilent,
  type LogFn,
  type Logger,
  pino,
} from "pino";

export const REDACTED = "[REDACTED]";

/** Claves cuyo valor se oculta completo. */
const SENSITIVE_KEY = /token|secret|password|authorization|key/i;
/** Credenciales dentro de una URL: `postgresql://usuario:clave@host` → `postgresql://[REDACTED]@host`. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi;
/** Parámetros sensibles de una URL: `?access_token=…`, `X-Amz-Signature=…`, `api_key=…`. */
const SENSITIVE_QUERY =
  /([?&][^=&#\s]*(?:token|secret|password|key|signature|credential)[^=&#\s]*=)[^&#\s]+/gi;

/** Oculta credenciales y parámetros sensibles de URLs dentro de un texto. */
export function redactText(text: string): string {
  return text.replace(URL_CREDENTIALS, `$1${REDACTED}@`).replace(SENSITIVE_QUERY, `$1${REDACTED}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactEntries(
  entries: [string, unknown][],
  ancestors: Set<object>,
): Record<string, unknown> {
  return Object.fromEntries(
    entries.map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : redactValue(item, ancestors),
    ]),
  );
}

function redactValue(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  const walkable = Array.isArray(value) || value instanceof Error || isPlainObject(value);
  if (!walkable) {
    return value;
  }
  // Solo es circular si el objeto ya está en el camino actual; un objeto compartido se repite.
  if (ancestors.has(value)) {
    return "[Circular]";
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, ancestors));
    }
    if (value instanceof Error) {
      // Copia plana: los errores de clientes HTTP y SDK traen `config`, `request` o `headers`.
      return {
        type: value.name,
        message: redactText(value.message),
        ...(value.stack ? { stack: redactText(value.stack) } : {}),
        ...(value.cause !== undefined ? { cause: redactValue(value.cause, ancestors) } : {}),
        ...redactEntries(Object.entries(value), ancestors),
      };
    }
    return redactEntries(Object.entries(value), ancestors);
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Copia `value` ocultando secretos a cualquier profundidad:
 * - el valor completo de las claves `token|secret|password|authorization|key`;
 * - credenciales y parámetros sensibles dentro de URLs en cualquier texto;
 * - lo anterior también dentro de errores (se copian a un objeto plano).
 */
export function redact(value: Record<string, unknown>): Record<string, unknown>;
export function redact(value: unknown): unknown;
export function redact(value: unknown): unknown {
  return redactValue(value, new Set());
}

export type LoggerOptions = {
  level?: LevelWithSilent;
  /** Salida legible con pino-pretty (desarrollo). Se ignora si se pasa `destination`. */
  pretty?: boolean;
  name?: string;
};

// Las firmas de pino son genéricas en niveles personalizados, que este proyecto no usa.
type ChildFn = (this: Logger, bindings: Bindings, options?: ChildLoggerOptions) => Logger;
type SetBindingsFn = (this: Logger, bindings: Bindings) => void;

/**
 * pino no pasa por los formatters los bindings de `child()` ni de `setBindings()`: se redactan
 * aquí. Basta con parchar la raíz, porque cada hijo hereda de su padre por prototipo.
 */
function redactBindings(logger: Logger): Logger {
  const baseChild = logger.child as unknown as ChildFn;
  const redactedChild: ChildFn = function (bindings, options) {
    return baseChild.call(this, redact(bindings), options);
  };
  logger.child = redactedChild as unknown as Logger["child"];

  const baseSetBindings = logger.setBindings as SetBindingsFn;
  const redactedSetBindings: SetBindingsFn = function (bindings) {
    baseSetBindings.call(this, redact(bindings));
  };
  logger.setBindings = redactedSetBindings;
  return logger;
}

/**
 * Logger pino que oculta secretos en los objetos logueados, en los bindings y en el texto
 * del mensaje (solo URLs con credenciales o parámetros sensibles; el resto del texto no se toca).
 */
export function createLogger(options: LoggerOptions = {}, destination?: DestinationStream): Logger {
  const config = {
    level: options.level ?? "info",
    ...(options.name ? { name: options.name } : {}),
    formatters: {
      log: (object: Record<string, unknown>) => redact(object),
    },
    hooks: {
      logMethod(this: Logger, args: Parameters<LogFn>, method: LogFn) {
        const redacted = args.map((arg) => (typeof arg === "string" ? redactText(arg) : arg));
        method.apply(this, redacted as Parameters<LogFn>);
      },
    },
  };
  if (destination) {
    return redactBindings(pino(config, destination));
  }
  if (options.pretty) {
    // Ruta absoluta: pino resuelve el transport desde su propia carpeta, no desde la app.
    const target = fileURLToPath(import.meta.resolve("pino-pretty"));
    return redactBindings(pino({ ...config, transport: { target } }));
  }
  return redactBindings(pino(config));
}
