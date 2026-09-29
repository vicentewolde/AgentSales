import type { Logger } from "@agentsales/config";
import type { MiddlewareHandler } from "hono";

/** Una línea por request: método, ruta (sin query), status y duración. */
export function requestLogger(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now();
    await next();
    logger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - start),
      },
      "request",
    );
  };
}
