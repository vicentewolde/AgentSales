import { AppError } from "@agentsales/core";
import { z } from "zod";
import { INSTAGRAM_LIMITS, INSTAGRAM_POLL } from "./constants.js";

/**
 * Lo que se sabe de un error de Instagram: el status HTTP y el `code` y `error_subcode` del cuerpo
 * (o el subcódigo del estado `ERROR` de un contenedor). Nunca el `message` de Meta, que puede traer
 * datos de la petición.
 */
export type InstagramErrorInfo = {
  httpStatus?: number | null;
  code?: number | null;
  subcode?: number | null;
  /** Minutos para recuperar el acceso (`estimated_time_to_regain_access`), si llegaron. */
  retryAfterMinutes?: number | null;
};

/** Sin dato de espera, el límite de llamadas se informa con 1 hora (nota §7.2). */
const DEFAULT_RETRY_AFTER_MINUTES = 60;

const MEDIA_REJECTED: Readonly<Record<number, string>> = {
  2207004: "Una imagen pesa más de 8 MB",
  2207005: "Instagram no acepta el formato de una imagen",
  2207009: "Una imagen tiene una proporción fuera de 4:5 a 1,91:1",
  2207010: `El caption supera los ${INSTAGRAM_LIMITS.captionMaxLength} caracteres`,
  2207023: "Instagram no reconoce el tipo de un medio",
  2207026: "Instagram no acepta el formato del video",
  2207028: `El carrusel debe tener de ${INSTAGRAM_LIMITS.carouselMinItems} a ${INSTAGRAM_LIMITS.carouselMaxItems} elementos`,
  2207035: "Instagram rechazó las etiquetas de la publicación",
  2207036: "Instagram rechazó las etiquetas de la publicación",
  2207037: "Instagram rechazó las etiquetas de la publicación",
  2207040: `El caption menciona a más de ${INSTAGRAM_LIMITS.mentionsMax} cuentas`,
  2207057: "La portada del reel queda fuera del video",
};
const ACCOUNT_RESTRICTED: Readonly<Record<number, string>> = {
  2207050:
    "La cuenta de Instagram está restringida, inactiva o con una verificación pendiente: revísala en la app",
  2207051:
    "Instagram restringió la actividad de la cuenta por sospecha de spam: revísala en la app",
};
const MEDIA_FETCH_FAILED = new Set([2207003, 2207052]);
const UNAVAILABLE_SUBCODES = new Set([2207001, 2207032, 2207053, 2207006, 2207020]);
/** No son errores (spec F3 §4.5): el medio aún se procesa y se sigue sondeando. */
export const INSTAGRAM_NOT_READY_SUBCODES: ReadonlySet<number> = new Set([2207008, 2207027]);
const RATE_LIMIT_CODES = new Set([4, 17, 80002, 613]);
const STATUS_AS_CODE: Readonly<Record<number, number>> = { 401: 190, 403: 10, 429: 4 };

const error = (code: string, message: string, retriable: boolean, info: InstagramErrorInfo) =>
  new AppError(code, message, {
    retriable,
    details: {
      httpStatus: info.httpStatus ?? null,
      graphCode: info.code ?? null,
      graphSubcode: info.subcode ?? null,
    },
  });

/**
 * Traduce un error de Instagram a un `AppError` (spec F3 §4.5, nota §7): primero por subcódigo y
 * después por código (el código 4 sirve tanto para el límite de llamadas como para 2207051, spam),
 * y al final por el status HTTP. Los mensajes son en español y sin datos del aviso, del token ni
 * de la petición. Lo que no calza con la tabla es `IG_REQUEST_REJECTED`, no reintentable.
 */
export function instagramError(info: InstagramErrorInfo): AppError {
  const { subcode, httpStatus } = info;
  // Sin código de Meta en el cuerpo (por ejemplo, una página HTML de un proxy), el status hace de
  // código: 401 como token inválido, 403 como permiso y 429 como límite. Los detalles guardan lo
  // que llegó de verdad.
  const code = info.code ?? (httpStatus == null ? null : STATUS_AS_CODE[httpStatus]) ?? null;
  if (subcode != null) {
    const rejected = MEDIA_REJECTED[subcode];
    if (rejected !== undefined) return error("IG_MEDIA_REJECTED", rejected, false, info);
    const restricted = ACCOUNT_RESTRICTED[subcode];
    if (restricted !== undefined) return error("IG_ACCOUNT_RESTRICTED", restricted, false, info);
    if (subcode === 2207042) return publishLimit(info);
    if (MEDIA_FETCH_FAILED.has(subcode)) {
      return error(
        "IG_MEDIA_FETCH_FAILED",
        "Instagram no pudo descargar una foto o el video: se reintenta con enlaces nuevos",
        true,
        info,
      );
    }
    if (UNAVAILABLE_SUBCODES.has(subcode)) return unavailable(info);
    if (INSTAGRAM_NOT_READY_SUBCODES.has(subcode)) {
      return error("IG_MEDIA_NOT_READY", "Instagram aún procesa el medio", true, info);
    }
  }
  if (code != null) {
    if (code === 190 || code === 102) {
      return error(
        "IG_AUTH_INVALID",
        "El acceso a Instagram venció o ya no es válido: reconecta la cuenta",
        false,
        info,
      );
    }
    if (code === 10 || (code >= 200 && code <= 299)) {
      return error(
        "IG_PERMISSION_DENIED",
        "La cuenta de Instagram no dio permiso para publicar: reconéctala y acepta los permisos",
        false,
        info,
      );
    }
    if (code === 9) return publishLimit(info);
    if (RATE_LIMIT_CODES.has(code)) {
      const minutes = info.retryAfterMinutes ?? DEFAULT_RETRY_AFTER_MINUTES;
      return error(
        "IG_RATE_LIMITED",
        `Instagram limitó las llamadas de la app: reintenta en ${minutes} minutos`,
        false,
        info,
      );
    }
    if (code === 1 || code === 2) return unavailable(info);
  }
  if (httpStatus != null && httpStatus >= 500) return unavailable(info);
  return error(
    "IG_REQUEST_REJECTED",
    `Instagram rechazó la petición (código ${code ?? httpStatus ?? "desconocido"})`,
    false,
    info,
  );
}

function publishLimit(info: InstagramErrorInfo) {
  return error(
    "IG_PUBLISH_LIMIT",
    "La cuenta llegó al máximo de publicaciones de Instagram en 24 horas: reintenta mañana",
    false,
    info,
  );
}

function unavailable(info: InstagramErrorInfo) {
  return error(
    "IG_UNAVAILABLE",
    "Instagram no respondió o tuvo un error propio: se reintenta",
    true,
    info,
  );
}

/** Errores que arma el publisher, no Instagram (spec F3 §4.5). */
export const INSTAGRAM_ERRORS = {
  /** Sin respuesta, se cortó la conexión o pasó el tope de la llamada. */
  unavailable: (reason: "network" | "timeout") =>
    new AppError(
      "IG_UNAVAILABLE",
      reason === "timeout"
        ? "Instagram no respondió a tiempo: se reintenta"
        : "No hubo conexión con Instagram: se reintenta",
      { retriable: true, details: { reason } },
    ),
  /** Se cortó con la señal (apagado del worker): el reintento retoma. */
  aborted: () => new AppError("IG_ABORTED", "Se cortó la llamada a Instagram", { retriable: true }),
  /** Un token que no puede ir en una cabecera (por ejemplo, con un salto de línea). */
  malformedToken: () =>
    new AppError(
      "IG_AUTH_INVALID",
      "El acceso guardado de Instagram no es válido: reconecta la cuenta",
      { details: { reason: "token_malformed" } },
    ),
  /** Una respuesta con otra forma: reintentar no la cambia. */
  unexpectedResponse: (call: string) =>
    new AppError("IG_UNEXPECTED_RESPONSE", "Instagram respondió algo inesperado", {
      details: { call },
    }),
  containerTimeout: () =>
    new AppError(
      "IG_CONTAINER_TIMEOUT",
      `Instagram no terminó de procesar el medio en ${INSTAGRAM_POLL.maxWaitMs / 60_000} minutos: se reintenta con uno nuevo`,
      { retriable: true },
    ),
  publishOutcomeUnknown: () =>
    new AppError(
      "IG_PUBLISH_OUTCOME_UNKNOWN",
      "No se sabe si la publicación salió en Instagram: revísalo antes de reintentar",
    ),
} as const;

/** Un código de Meta: número entero o texto con dígitos; otra cosa (null, "", true) no cuenta. */
const graphCodeSchema = z
  .union([
    z.number().int(),
    z
      .string()
      .regex(/^-?\d+$/)
      .transform(Number),
  ])
  .optional()
  .catch(undefined);

/**
 * El error dentro de un cuerpo de Instagram, en sus dos formas: la de Graph
 * (`{ error: { code, error_subcode } }`) y la del canje del código en `api.instagram.com`
 * (`{ error_type, code, error_message }`). `null` si el cuerpo no trae un error.
 */
export function graphErrorOf(body: unknown): { code?: number; subcode?: number } | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const nested = record.error;
  if (typeof nested === "object" && nested !== null) {
    const fields = nested as Record<string, unknown>;
    return {
      code: graphCodeSchema.parse(fields.code),
      subcode: graphCodeSchema.parse(fields.error_subcode),
    };
  }
  if (typeof record.error_type === "string") {
    return { code: graphCodeSchema.parse(record.code) };
  }
  return null;
}

/**
 * Minutos de espera de `X-Business-Use-Case-Usage` (nota §6): el mayor
 * `estimated_time_to_regain_access` que traiga. `null` si no llega o no se entiende.
 */
export function retryAfterMinutesOf(header: string | null): number | null {
  if (header === null) return null;
  try {
    const usage: unknown = JSON.parse(header);
    if (typeof usage !== "object" || usage === null) return null;
    const minutes = Object.values(usage)
      .flatMap((entries) => (Array.isArray(entries) ? entries : []))
      .map((entry) =>
        typeof entry === "object" && entry !== null
          ? Number((entry as Record<string, unknown>).estimated_time_to_regain_access)
          : Number.NaN,
      )
      .filter((value) => Number.isFinite(value) && value > 0);
    return minutes.length === 0 ? null : Math.max(...minutes);
  } catch {
    return null;
  }
}
