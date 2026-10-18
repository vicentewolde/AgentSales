import type { MiddlewareHandler } from "hono";
import { routePathOf } from "./access.js";
import type { AppLogger } from "./logger.js";

/**
 * Rutas que se sondean (el panel, y desde F8-T11 el chequeo de Fly cada 30 s): van en `debug` para
 * no llenar el log. Se comparan sin el prefijo `/api` (spec F8 §4.3).
 */
const QUIET_PATHS = new Set(["/health", "/health/live"]);

/** Una línea por request: método, ruta (sin query), status y duración; 5xx en `warn`. */
export function requestLogger(logger: AppLogger): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now();
    await next();
    const status = c.res.status;
    const level =
      status >= 500 ? "warn" : QUIET_PATHS.has(routePathOf(c.req.path)) ? "debug" : "info";
    logger[level](
      { method: c.req.method, path: c.req.path, status, ms: Math.round(performance.now() - start) },
      "request",
    );
  };
}
