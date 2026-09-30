import type { PublishMode } from "@agentsales/core";
import { Hono } from "hono";
import { createErrorHandler, notFoundHandler } from "./errors.js";
import { type CheckName, type HealthCheck, runHealth } from "./health.js";
import type { AppLogger } from "./logger.js";
import { requestLogger } from "./request-logger.js";
import { csrfGuard, hostGuard, type LocalAccess } from "./security.js";

export type AppDeps = {
  checks: Record<CheckName, HealthCheck>;
  publishMode: PublishMode;
  version: string;
  logger: AppLogger;
  /** Hosts y orígenes locales permitidos (`localAccess(API_PORT, WEB_PORT)`). */
  access: LocalAccess;
  /** Solo para tests; por defecto `DEFAULT_CHECK_TIMEOUT_MS`. */
  checkTimeoutMs?: number;
};

/** Arma la API con sus dependencias inyectadas. Las rutas van encadenadas para el cliente `hc`. */
export function createApp(deps: AppDeps) {
  const app = new Hono()
    .use(requestLogger(deps.logger))
    .use(hostGuard(deps.access.allowedHosts))
    .use(csrfGuard(deps.access.allowedOrigins))
    .get("/health", async (c) => {
      const report = await runHealth({
        checks: deps.checks,
        publishMode: deps.publishMode,
        version: deps.version,
        ...(deps.checkTimeoutMs === undefined ? {} : { timeoutMs: deps.checkTimeoutMs }),
      });
      // Siempre 200: el estado va en el cuerpo (`ok` o `degraded`).
      return c.json(report, 200);
    });
  app.onError(createErrorHandler(deps.logger));
  app.notFound(notFoundHandler);
  return app;
}

/** Tipo de la API para el cliente RPC (`hc<AppType>`) de la CLI y el panel. */
export type AppType = ReturnType<typeof createApp>;
