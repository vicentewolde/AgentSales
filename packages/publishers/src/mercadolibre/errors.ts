import { AppError } from "@agentsales/core";
import { z } from "zod";

/** Una causa de un rechazo (`cause[]`, nota §7), sin su `message`, que puede traer datos del aviso. */
export type MercadoLibreCause = {
  /** `item.attributes.missing_required`, `seller_contact.phone.invalid`, … */
  code: string | null;
  /** `147`, `126`, … */
  causeId: number | null;
  /** `error` bloquea; `warning` no (nota §7). */
  type: string | null;
};

/** Lo que se sabe de un error de Mercado Libre: el status y los códigos del cuerpo, nunca su texto. */
export type MercadoLibreErrorInfo = {
  httpStatus: number | null;
  /** El campo `error` del cuerpo: `invalid_grant`, `forbidden`, `validation_error`, … */
  error: string | null;
  causes: readonly MercadoLibreCause[];
};

/**
 * Un identificador de Mercado Libre (`item.price.invalid`, `invalid_grant`). Otra cosa (con espacios
 * o comillas) podría ser un texto con datos de la petición y no se guarda.
 */
const IDENTIFIER = /^[A-Za-z0-9_.-]{1,100}$/;
const identifierSchema = z
  .string()
  .regex(IDENTIFIER)
  .nullish()
  .catch(null)
  .transform((value) => value ?? null);
const causeIdSchema = z
  .union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)])
  .nullish()
  .catch(null)
  .transform((value) => value ?? null);
const causeSchema = z
  .object({ code: identifierSchema, cause_id: causeIdSchema, type: identifierSchema })
  .transform(({ code, cause_id, type }) => ({ code, causeId: cause_id, type }));

/**
 * El error dentro de un cuerpo de Mercado Libre: `error` y `cause[]` (nota §7), con lo que no se
 * entiende descartado. `null` si el cuerpo no es un objeto.
 */
export function mercadoLibreErrorOf(
  body: unknown,
): Omit<MercadoLibreErrorInfo, "httpStatus"> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const causes = Array.isArray(record.cause)
    ? record.cause.flatMap((cause) => {
        const parsed = causeSchema.safeParse(cause);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  return { error: identifierSchema.parse(record.error), causes };
}

/**
 * Causas conocidas de un rechazo (nota §7), por `code` o, si no vino, por `cause_id`. Los textos
 * son en español y sin datos del aviso.
 */
const CAUSE_MESSAGES: ReadonlyArray<{
  codes: readonly string[];
  ids: readonly number[];
  text: string;
}> = [
  {
    codes: ["item.category_id.invalid"],
    ids: [126],
    text: "la categoría no es una categoría final de inmuebles",
  },
  {
    codes: ["item.attributes.missing_required"],
    ids: [147],
    text: "falta un atributo obligatorio de la categoría",
  },
  {
    codes: ["item.attribute.missing_conditional_required"],
    ids: [7810],
    text: "falta un atributo que la categoría exige en este caso",
  },
  {
    codes: ["item.listing_type_id.requiresPictures", "LTP_PICTURE_REQUIRED"],
    ids: [173],
    text: "el aviso necesita al menos una foto",
  },
  { codes: ["item.pictures.max"], ids: [201], text: "el aviso tiene más fotos de las permitidas" },
  {
    codes: ["item.pictures.invalid_size"],
    ids: [3703],
    text: "una foto es demasiado chica o tiene un error",
  },
  {
    codes: ["item.price.invalid"],
    ids: [109, 129],
    text: "el precio está bajo el mínimo o sobre el máximo",
  },
  {
    codes: ["item.description.type.invalid"],
    ids: [398],
    text: "la descripción tiene caracteres que Mercado Libre no acepta",
  },
];

/** Una causa en español: la de la tabla, la del contacto, o el código tal cual. */
export function describeCause(cause: MercadoLibreCause): string {
  const known = CAUSE_MESSAGES.find(
    (entry) =>
      (cause.code !== null && entry.codes.includes(cause.code)) ||
      (cause.code === null && cause.causeId !== null && entry.ids.includes(cause.causeId)),
  );
  if (known) return known.text;
  if (cause.code?.startsWith("seller_contact.")) {
    return "falta el contacto del corredor o está mal escrito (WhatsApp)";
  }
  return `otra causa (${cause.code ?? cause.causeId ?? "sin código"})`;
}

/** Una causa sin `type` cuenta como error: dejar pasar un rechazo sería peor. */
const isBlocking = (cause: MercadoLibreCause) => cause.type !== "warning";

const error = (code: string, message: string, retriable: boolean, info: MercadoLibreErrorInfo) =>
  new AppError(code, message, {
    retriable,
    details: { httpStatus: info.httpStatus, error: info.error, causes: info.causes },
  });

/**
 * Traduce un error de Mercado Libre a un `AppError` (spec F4 §4.8, nota §7): primero por el campo
 * `error` (los del OAuth), después por el status y, en un 4xx, por las causas que bloquean. Nunca
 * lleva el `message` de Mercado Libre ni datos del aviso. Lo que no calza es `ML_REQUEST_REJECTED`,
 * no reintentable. Un 401 es `ML_AUTH_INVALID` con `httpStatus: 401`: quien llama refresca el token
 * una vez y repite (ADR-0015); `invalid_grant` no se arregla refrescando.
 */
export function mercadoLibreError(info: MercadoLibreErrorInfo): AppError {
  const { httpStatus } = info;
  switch (info.error) {
    case "invalid_grant":
      return error(
        "ML_AUTH_INVALID",
        "El acceso a Mercado Libre venció, se revocó o ya se usó: reconecta la cuenta",
        false,
        info,
      );
    case "invalid_client":
    case "unauthorized_client":
      return error(
        "ML_APP_CREDENTIALS_INVALID",
        "Mercado Libre no reconoce la app (ML_APP_ID o ML_CLIENT_SECRET): revisa el .env y vuelve a intentar; la cuenta no cambia",
        false,
        info,
      );
    case "unauthorized_application":
      return error(
        "ML_PERMISSION_DENIED",
        "Mercado Libre bloqueó la app: revísala en developers.mercadolibre.cl",
        false,
        info,
      );
    case "local_rate_limited":
      return rateLimited(info);
  }
  if (httpStatus === 429) return rateLimited(info);
  if (httpStatus === 401) {
    return error(
      "ML_AUTH_INVALID",
      "Mercado Libre no aceptó el acceso de la cuenta: reconéctala",
      false,
      info,
    );
  }
  if (httpStatus === 403) {
    return error(
      "ML_PERMISSION_DENIED",
      "La cuenta de Mercado Libre no dio permiso para esto: reconéctala con la cuenta administradora y acepta los permisos",
      false,
      info,
    );
  }
  if (httpStatus === 409) {
    return error(
      "ML_CONFLICT",
      "Mercado Libre estaba cambiando el aviso al mismo tiempo: se reintenta",
      true,
      info,
    );
  }
  if (httpStatus !== null && httpStatus >= 500) return unavailable(info);
  const blocking = info.causes.filter(isBlocking);
  if (httpStatus !== null && httpStatus >= 400 && blocking.length > 0) {
    const reasons = [...new Set(blocking.map(describeCause))];
    return error(
      "ML_ITEM_REJECTED",
      `Mercado Libre rechazó el aviso: ${reasons.join("; ")}`,
      false,
      info,
    );
  }
  return error(
    "ML_REQUEST_REJECTED",
    `Mercado Libre rechazó la petición (${info.error ?? `código ${httpStatus ?? "desconocido"}`})`,
    false,
    info,
  );
}

function rateLimited(info: MercadoLibreErrorInfo) {
  return error(
    "ML_RATE_LIMITED",
    "Mercado Libre limitó las llamadas de la app: se reintenta más tarde",
    true,
    info,
  );
}

function unavailable(info: MercadoLibreErrorInfo) {
  return error(
    "ML_UNAVAILABLE",
    "Mercado Libre no respondió o tuvo un error propio: se reintenta",
    true,
    info,
  );
}

/** Errores que arma el cliente, no Mercado Libre (spec F4 §4.8). */
export const MERCADOLIBRE_ERRORS = {
  /** Sin respuesta, se cortó la conexión o pasó el tope de la llamada. */
  unavailable: (reason: "network" | "timeout") =>
    new AppError(
      "ML_UNAVAILABLE",
      reason === "timeout"
        ? "Mercado Libre no respondió a tiempo: se reintenta"
        : "No hubo conexión con Mercado Libre: se reintenta",
      { retriable: true, details: { reason } },
    ),
  /** Se cortó con la señal (apagado del worker): el reintento retoma. */
  aborted: () =>
    new AppError("ML_ABORTED", "Se cortó la llamada a Mercado Libre", { retriable: true }),
  /** Un token que no puede ir en una cabecera ni en un formulario (por ejemplo, con un salto de línea). */
  malformedToken: () =>
    new AppError(
      "ML_AUTH_INVALID",
      "El acceso guardado de Mercado Libre no es válido: reconecta la cuenta",
      { details: { reason: "token_malformed" } },
    ),
  /** Una respuesta con otra forma: reintentar no la cambia. */
  unexpectedResponse: (call: string) =>
    new AppError("ML_UNEXPECTED_RESPONSE", "Mercado Libre respondió algo inesperado", {
      details: { call },
    }),
} as const;
