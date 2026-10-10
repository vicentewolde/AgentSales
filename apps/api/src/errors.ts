import { isAppError } from "@agentsales/core";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
// El cuerpo de error vive en los contratos compartidos (ADR-0011): un cambio rompe el typecheck
// de la API, la CLI y el panel a la vez.
import { type ErrorBody, errorBodySchema, readinessSchema } from "./contracts/index.js";
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
  // F4-T16: al aviso le falta lo que pide Portal; se completa la planilla y se publica de nuevo.
  // La respuesta lleva la lista de lo que falta (`issues`, F4-T19, seguimiento de ADR-0011).
  "PORTAL_NOT_READY",
  // Publicar Portal (spec F4 §4.5 y §4.6): la hoja o la comuna no se encuentran en el catálogo
  // (se corrige el tipo o la ubicación en la planilla), o el aviso cambió desde que se aprobó.
  "PORTAL_CATEGORY_NOT_FOUND",
  "PORTAL_LOCATION_NOT_FOUND",
  "PUBLICATION_LISTING_CHANGED",
  // Pausar, reactivar, cerrar y el sync (F4-T17 y T19): el estado o el modo no lo permiten, falta
  // confirmar el cierre, o lo guardado de la publicación no sirve (se cambia a mano en Mercado
  // Libre); Mercado Libre rechazó el cambio o hubo un conflicto; el sync leyó algo que cambió.
  "RETIRE_NOT_SUPPORTED",
  "OPERATION_NOT_SUPPORTED",
  "PUBLISH_MODE_MISMATCH",
  "CLOSE_NOT_CONFIRMED",
  "PORTAL_PROGRESS_UNUSABLE",
  "PUBLICATION_NOT_PUBLISHED",
  "PUBLICATION_SYNC_STALE",
  "ML_ITEM_REJECTED",
  "ML_CONFLICT",
  // Sin un paquete con cupo (un 402 sin causas, spec F4 §4.8): se revisa el paquete en Mercado Libre.
  "ML_NO_QUOTA",
  // Marketplace (spec F5 §4.10): al aviso le falta lo que pide el formulario (con `issues`), la
  // cuenta llegó a su límite de hoy u otra tiene el formulario abierto; una publicación espera el
  // clic final (descartar, quitar la aprobación, desconectar); ya se confirmó con otro enlace; falta
  // confirmar la desconexión; otra acción del perfil de Facebook espera su turno.
  "MARKETPLACE_NOT_READY",
  "MARKETPLACE_DAILY_LIMIT",
  "MARKETPLACE_FORM_OPEN",
  "MANUAL_CONFIRM_PENDING",
  "PUBLICATION_ALREADY_CONFIRMED",
  "DISCONNECT_NOT_CONFIRMED",
  "MARKETPLACE_PROFILE_ACTION_PENDING",
]);

/**
 * Lo que el cliente tiene que mandar y no mandó (400), sin el sufijo `_INVALID`: confirmar en vivo
 * una de Marketplace sin el enlace del aviso (spec F5 §4.3).
 */
const CLIENT_MISSING = new Set(["MARKETPLACE_URL_REQUIRED"]);

/**
 * Errores de la plataforma que llegan a la API al conectar (spec F3 §4.8) y, desde F4-T19, en
 * pausar, reactivar y cerrar (al publicar solo viajan en `last_error`): un token o permiso que la
 * plataforma rechaza es del cliente (400: reconectar), y una respuesta con otra forma es un fallo de
 * ella (502). `*_UNAVAILABLE` (503) y `*_RATE_LIMITED` (429) siguen las reglas generales.
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

/**
 * Una respuesta de la plataforma con otra forma: un fallo de ella (502). La UF (spec F5 §4.6): la
 * API no la consulta (sus errores viajan en `last_error`), pero si uno llegara, un valor ilegible o
 * fuera de rango es un fallo del Banco Central, no del cliente.
 */
const PLATFORM_UNEXPECTED = new Set([
  "IG_UNEXPECTED_RESPONSE",
  "ML_UNEXPECTED_RESPONSE",
  "UF_UNEXPECTED_RESPONSE",
  "UF_VALUE_INVALID",
  "UF_VALUE_SUSPICIOUS",
]);

/**
 * La API no puede hablar con la plataforma por su propia configuración (falta el par de la app, o
 * Mercado Libre no lo reconoce): 503 hasta que el operador corrija `.env` y reinicie.
 */
const NOT_CONFIGURED = new Set([
  "MERCADOLIBRE_NOT_CONFIGURED",
  "ML_APP_CREDENTIALS_INVALID",
  // F4-T19: la API no tiene las operaciones de esa plataforma (no debería pasar: `server.ts` las
  // compone).
  "PUBLISHER_NOT_CONFIGURED",
  // La UF (spec F5 §4.6): sin token del Banco Central, o con uno que rechaza; el Banco Central
  // todavía no publica el valor de hoy (se reintenta más tarde).
  "UF_SOURCE_NOT_CONFIGURED",
  "UF_SOURCE_AUTH_INVALID",
  "UF_VALUE_MISSING",
]);

/**
 * Otro proceso tiene el recurso un momento (F4-T08: el candado de credenciales, mientras el worker
 * o la API renuevan el acceso de la cuenta): 503, y el pedido se repite en un momento.
 */
const BUSY = new Set([
  "ACCOUNT_LOCK_TIMEOUT",
  // F4-T19: una operación cortada por el tope de la API (las rutas de operaciones le ponen su
  // mensaje: ya pidió el sync).
  "ML_ABORTED",
  // F5: el perfil de Facebook lo tiene otra ventana un momento.
  "MARKETPLACE_PROFILE_BUSY",
]);

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
  // Credenciales guardadas que no sirven (F4-T08: sin el `refresh_token` de Mercado Libre al
  // refrescar a pedido): la cuenta queda en `error`, como con CREDENTIALS_UNREADABLE (500).
  "CREDENTIALS_INVALID",
  // Lo que el cliente de Mercado Libre rechaza antes de enviar: datos del servidor, no del cliente.
  "ML_ID_INVALID",
  "ML_BODY_INVALID",
  "ML_PICTURE_INVALID",
  // Lo que informó la plataforma no calza con `remoteStateSchema` (el sync, F4-T17).
  "PUBLICATION_REMOTE_STATE_INVALID",
  // F5 (spec F5 §4.10): pedir un token a una cuenta sin credenciales (por su sufijo caería en 503),
  // credenciales que faltan o sobran según la plataforma (errores de programación), y lo que arma
  // el worker con el perfil de Facebook (su carpeta, el id de la sesión).
  "ACCESS_TOKEN_UNAVAILABLE",
  "ACCOUNT_CREDENTIALS_REQUIRED",
  "ACCOUNT_CREDENTIALS_NOT_ALLOWED",
  "MARKETPLACE_PROFILE_PATH_INVALID",
  "MARKETPLACE_SESSION_ID_INVALID",
]);

/**
 * Status HTTP de un `AppError` según su código (docs/05-convenciones.md). Se evalúa en orden:
 * primero los códigos exactos, luego los patrones; lo que no calza es 500.
 */
export function httpStatusFor(code: string): ContentfulStatusCode {
  if (code === "INVALID_TRANSITION" || CONFLICTS.has(code)) return 409;
  if (code === "REQUEST_TOO_LARGE") return 413;
  if (CLIENT_MISSING.has(code)) return 400;
  if (PLATFORM_REJECTIONS.has(code)) return 400;
  if (PLATFORM_UNEXPECTED.has(code)) return 502;
  if (NOT_CONFIGURED.has(code) || BUSY.has(code)) return 503;
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

/** Lo que un error suma a `code` y `message` (`issues`, `publicationId`), ya validado. */
type ErrorExtras = Pick<ErrorBody["error"], "issues" | "publicationId">;

export function errorJson(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  headers?: Headers,
  extras: ErrorExtras = {},
): Response {
  const response = c.json<ErrorBody>({ error: { code, message, ...extras } }, status);
  headers?.forEach((value, name) => {
    if (name !== "content-type" && name !== "content-length") {
      response.headers.set(name, value);
    }
  });
  return response;
}

/** Los errores que dicen qué le falta al aviso para un canal (`issues`). */
const READINESS_CODES = new Set(["PORTAL_NOT_READY", "MARKETPLACE_NOT_READY"]);

/** Los errores que nombran la publicación de Marketplace que espera el clic final. */
const WAITING_PUBLICATION_CODES = new Set(["MANUAL_CONFIRM_PENDING", "MARKETPLACE_FORM_OPEN"]);

/**
 * Lo único de `details` que sale (seguimiento de ADR-0011), campo por campo y validado; si no
 * calza, la respuesta va sin ello:
 * - `issues` de `PORTAL_NOT_READY` (desde F4-T19) y `MARKETPLACE_NOT_READY` (F5-T08): código,
 *   campo del Excel y motivo en español, sin datos del aviso;
 * - `publicationId` de `MANUAL_CONFIRM_PENDING` y `MARKETPLACE_FORM_OPEN` (F5-T08): la publicación
 *   que espera el clic final (un id, para ofrecer "lo publiqué" o "no lo publiqué").
 */
function extrasOf(code: string, details: Record<string, unknown> | undefined): ErrorExtras {
  if (READINESS_CODES.has(code)) {
    const parsed = readinessSchema.shape.issues.safeParse(details?.issues);
    return parsed.success
      ? {
          issues: parsed.data.map(({ code: issueCode, field, message }) => ({
            code: issueCode,
            field,
            message,
          })),
        }
      : {};
  }
  if (WAITING_PUBLICATION_CODES.has(code)) {
    const parsed = errorBodySchema.shape.error.shape.publicationId.safeParse(
      details?.publicationId,
    );
    return parsed.success && parsed.data !== undefined ? { publicationId: parsed.data } : {};
  }
  return {};
}

/**
 * Traduce cualquier error a `{ error: { code, message } }`:
 * - nunca expone `details` ni `cause`, salvo lo que deja pasar `extrasOf`;
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
      return errorJson(
        c,
        status,
        error.code,
        error.message,
        undefined,
        extrasOf(error.code, error.details),
      );
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
