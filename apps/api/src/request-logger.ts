import type { MiddlewareHandler } from "hono";
import type { AppLogger } from "./logger.js";

/** Rutas que el panel sondea: van en `debug` para no llenar el log. */
const QUIET_PATHS = new Set(["/health"]);

/** Una línea por request: método, ruta (sin query), status y duración; 5xx en `warn`. */
export function requestLogger(logger: AppLogger): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now();
    await next();
    const status = c.res.status;
    const level = status >= 500 ? "warn" : QUIET_PATHS.has(c.req.path) ? "debug" : "info";
    logger[level](
      { method: c.req.method, path: c.req.path, status, ms: Math.round(performance.now() - start) },
      "request",
    );
  };
}
