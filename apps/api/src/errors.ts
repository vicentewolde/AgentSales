import type { Logger } from "@agentsales/config";
import { isAppError } from "@agentsales/core";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorBody = { error: { code: string; message: string } };

/**
 * Status HTTP de un `AppError` según su código (docs/05-convenciones.md). Se evalúa en orden:
 * primero los códigos exactos, luego los patrones; lo que no calza es 500.
 */
export function httpStatusFor(code: string): ContentfulStatusCode {
  if (code === "INVALID_TRANSITION") return 409;
  if (code.endsWith("_NOT_FOUND")) return 404;
  if (code.includes("_INVALID") || code.startsWith("INVALID_")) return 400;
  if (code.endsWith("_RATE_LIMITED")) return 429;
  if (code.endsWith("_UNAVAILABLE")) return 503;
  return 500;
}

function errorJson(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json<ErrorBody>({ error: { code, message } }, status);
}

/**
 * Traduce cualquier error a `{ error: { code, message } }`. Nunca expone `details` ni `cause`,
 * y un error inesperado responde un mensaje genérico: el detalle queda solo en el log (redactado).
 */
export function createErrorHandler(logger: Logger): ErrorHandler {
  return (error, c) => {
    if (isAppError(error)) {
      const status = httpStatusFor(error.code);
      const log = status >= 500 ? logger.error.bind(logger) : logger.warn.bind(logger);
      log({ err: error, path: c.req.path }, "error de la aplicación");
      return errorJson(c, status, error.code, error.message);
    }
    if (error instanceof HTTPException && error.status < 500) {
      return errorJson(c, error.status, "HTTP_ERROR", error.message);
    }
    logger.error({ err: error, path: c.req.path }, "error inesperado");
    return errorJson(c, 500, "INTERNAL_ERROR", "Error interno del servidor");
  };
}

export const notFoundHandler: NotFoundHandler = (c) =>
  errorJson(c, 404, "ROUTE_NOT_FOUND", `No existe ${c.req.method} ${c.req.path}`);
