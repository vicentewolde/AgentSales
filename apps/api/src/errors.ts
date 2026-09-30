import { isAppError } from "@agentsales/core";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppLogger } from "./logger.js";

export type ErrorBody = { error: { code: string; message: string } };

const INTERNAL_MESSAGE = "Error interno del servidor";

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

export function errorJson(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  headers?: Headers,
): Response {
  const response = c.json<ErrorBody>({ error: { code, message } }, status);
  headers?.forEach((value, name) => {
    if (name !== "content-type" && name !== "content-length") {
      response.headers.set(name, value);
    }
  });
  return response;
}

/**
 * Traduce cualquier error a `{ error: { code, message } }`:
 * - nunca expone `details` ni `cause`;
 * - un 500 responde un mensaje genérico (el `code` sí se mantiene): el detalle queda en el log;
 * - un error que no es `AppError` responde `500 INTERNAL_ERROR`.
 */
export function createErrorHandler(logger: AppLogger): ErrorHandler {
  return (error, c) => {
    if (isAppError(error)) {
      const status = httpStatusFor(error.code);
      if (status === 500) {
        logger.error({ err: error, path: c.req.path }, "error de la aplicación");
        return errorJson(c, status, error.code, INTERNAL_MESSAGE);
      }
      logger.warn({ err: error, path: c.req.path }, "error de la aplicación");
      return errorJson(c, status, error.code, error.message);
    }
    if (error instanceof HTTPException && error.status < 500) {
      const status = error.status as ContentfulStatusCode;
      return errorJson(c, status, `HTTP_${status}`, error.message, error.getResponse().headers);
    }
    // `c.req.json()` con un cuerpo mal formado lanza SyntaxError: es un error del cliente.
    if (
      error instanceof SyntaxError &&
      c.req.header("content-type")?.includes("application/json")
    ) {
      return errorJson(c, 400, "INVALID_JSON", "El cuerpo de la petición no es JSON válido");
    }
    logger.error({ err: error, path: c.req.path }, "error inesperado");
    return errorJson(c, 500, "INTERNAL_ERROR", INTERNAL_MESSAGE);
  };
}

export const notFoundHandler: NotFoundHandler = (c) =>
  errorJson(c, 404, "ROUTE_NOT_FOUND", `No existe ${c.req.method} ${c.req.path}`);
