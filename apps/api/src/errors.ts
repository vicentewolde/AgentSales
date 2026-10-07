import { isAppError } from "@agentsales/core";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
// El cuerpo de error vive en los contratos compartidos (ADR-0011): un cambio rompe el typecheck
// de la API, la CLI y el panel a la vez.
import type { ErrorBody } from "./contracts/index.js";
import type { AppLogger } from "./logger.js";

export type { ErrorBody };

const INTERNAL_MESSAGE = "Error interno del servidor";

/**
 * Pedidos válidos que el estado actual no permite (spec F2 §4.7): el cliente puede corregirlos
 * (esperar, recargar, descartar o confirmar), así que son 409. Los demás `*_CONFLICT` (carreras
 * entre intentos de un job) son 500; `PUBLICATION_CONFLICT` es 409 por el spec F3 §4.8.
 */
const CONFLICTS = new Set([
  "LISTING_NOT_READY",
  "CONTENT_EDITED",
  "CONTENT_NOT_CURRENT",
  "CONTENT_RUN_ACTIVE",
  // F3 (ADR-0014): lo aprobado no cambia mientras tenga publicaciones activas o pendientes.
  "CONTENT_LOCKED",
  "PUBLICATION_PENDING",
  // Refrescar (F3-T14) o publicar con una cuenta desconectada o vencida: hay que reconectarla.
  "ACCOUNT_NOT_CONNECTED",
  "ACCOUNT_REFRESH_UNSUPPORTED",
  // Aprobar y publicar (F3-T05 y T10, spec F3 §4.8): el cliente corrige el estado (revisar el
  // texto, esperar, descartar o confirmar) y vuelve a pedirlo.
  "CONTENT_HAS_ERRORS",
  "CONTENT_NOT_READY",
  "CONTENT_NOT_APPROVED",
  "PUBLICATION_IN_PROGRESS",
  "PUBLICATION_CONFLICT",
  "NOTHING_TO_PUBLISH",
  "REMOVAL_NOT_CONFIRMED",
  "PUBLISH_MODE_LOCKED",
]);

/**
 * Errores de Instagram que llegan a la API al conectar (spec F3 §4.8; al publicar solo viajan en
 * `last_error`): un token o permiso que Instagram rechaza es del cliente (400), y una respuesta con
 * otra forma es un fallo de la plataforma (502). `IG_UNAVAILABLE` (503) e `IG_RATE_LIMITED` (429)
 * siguen las reglas generales.
 */
const PLATFORM_REJECTIONS = new Set([
  "IG_AUTH_INVALID",
  "IG_PERMISSION_DENIED",
  "IG_REQUEST_REJECTED",
  // Mercado Libre al conectar (spec F4 §4.11): un código o permiso rechazado, o una cuenta de otro
  // país, son del cliente; reconectar los arregla.
  "ML_AUTH_INVALID",
  "ML_PERMISSION_DENIED",
  "ML_SITE_MISMATCH",
  "ML_REQUEST_REJECTED",
]);

/** Una respuesta de la plataforma con otra forma: un fallo de ella (502). */
const PLATFORM_UNEXPECTED = new Set(["IG_UNEXPECTED_RESPONSE", "ML_UNEXPECTED_RESPONSE"]);

/**
 * La API no puede hablar con la plataforma por su propia configuración (falta el par de la app, o
 * Mercado Libre no lo reconoce): 503 hasta que el operador corrija `.env` y reinicie.
 */
const NOT_CONFIGURED = new Set(["MERCADOLIBRE_NOT_CONFIGURED", "ML_APP_CREDENTIALS_INVALID"]);

/**
 * Datos inválidos que arma el servidor, no el cliente: los de un job, un run guardado y lo que el
 * repositorio de publicaciones recibe de core (F3-T15). Son 500 aunque terminen en `_INVALID`.
 */
const SERVER_INVALID = new Set([
  "JOB_PAYLOAD_INVALID",
  "IMPORT_RUN_INVALID",
  "PUBLICATION_EVENT_INVALID",
  "PUBLICATION_REFERENCE_INVALID",
  "PUBLICATION_PROGRESS_INVALID",
  // Lo que el cliente de Mercado Libre rechaza antes de enviar: datos del servidor, no del cliente.
  "ML_ID_INVALID",
  "ML_BODY_INVALID",
  "ML_PICTURE_INVALID",
]);

/**
 * Status HTTP de un `AppError` según su código (docs/05-convenciones.md). Se evalúa en orden:
 * primero los códigos exactos, luego los patrones; lo que no calza es 500.
 */
export function httpStatusFor(code: string): ContentfulStatusCode {
  if (code === "INVALID_TRANSITION" || CONFLICTS.has(code)) return 409;
  if (code === "REQUEST_TOO_LARGE") return 413;
  if (PLATFORM_REJECTIONS.has(code)) return 400;
  if (PLATFORM_UNEXPECTED.has(code)) return 502;
  if (NOT_CONFIGURED.has(code)) return 503;
  // Datos inválidos que no vienen del cliente (`SERVER_INVALID`), y una fila corrupta en la base
  // (`*_ROW_INVALID`): son fallos del servidor.
  if (SERVER_INVALID.has(code)) return 500;
  if (code.endsWith("_ROW_INVALID")) return 500;
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
    // `hono/validator` rechaza un JSON mal formado con su propio 400 en inglés: mismo trato que
    // el `SyntaxError` de `c.req.json()`.
    if (
      error instanceof HTTPException &&
      error.status === 400 &&
      /^Malformed JSON/.test(error.message)
    ) {
      return errorJson(c, 400, "INVALID_JSON", "El cuerpo de la petición no es JSON válido");
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
