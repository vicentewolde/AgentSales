import { AppError, isAppError, redactText } from "@agentsales/core";
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
 * o comillas) podría ser un texto con datos de la petición, y algo con forma de token (`APP_USR-…`,
 * `TG-…`, o que termina en un id de usuario como ellos) podría ser un secreto: no se guardan.
 */
const IDENTIFIER = /^[A-Za-z0-9_.-]{1,100}$/;
const looksLikeToken = (value: string) => redactText(value) !== value || /-\d{5,}$/.test(value);
const identifierSchema = z
  .string()
  .regex(IDENTIFIER)
  .refine((value) => !looksLikeToken(value))
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

/** Causas que se guardan como máximo: basta para explicar el rechazo sin inflar la bitácora. */
export const MAX_CAUSES = 20;

/**
 * El error dentro de un cuerpo de Mercado Libre: `error` y `cause[]` (nota §7), con lo que no se
 * entiende descartado. `null` si el cuerpo no es un objeto.
 */
export function mercadoLibreErrorOf(
  body: unknown,
): Omit<MercadoLibreErrorInfo, "httpStatus"> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  return { error: identifierSchema.parse(record.error), causes: parseCauses(record.cause) };
}

/**
 * Una lista de causas (`cause[]` de un error, o las advertencias de una respuesta que salió bien),
 * con lo que no se entiende descartado y como máximo `MAX_CAUSES`. `[]` si no es una lista.
 */
export function parseCauses(value: unknown): MercadoLibreCause[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((cause) => {
      const parsed = causeSchema.safeParse(cause);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, MAX_CAUSES);
}

/**
 * Causas conocidas de un rechazo (nota §7), por `code` o, si no vino, por `cause_id` (508 y 509,
 * que llegan con un código que la doc no muestra, siempre por `cause_id`). Los textos son en
 * español y sin datos del aviso.
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
  // Visto con `ml:smoke` el 2026-10-08: un título de 61 caracteres en una hoja de 60.
  {
    codes: ["item.title.length.invalid"],
    ids: [134],
    text: "el título es más largo de lo que permite la categoría",
  },
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
  // 508 y 509 llegan como causas de un 400 `validation_error` (doc de imágenes, leída el
  // 2026-10-07), con un código que la doc no muestra: se reconocen por `cause_id`.
  {
    codes: [],
    ids: [508],
    text: "una foto subida quedó con error en Mercado Libre: hay que subirla de nuevo",
  },
  {
    codes: [],
    ids: [509],
    text: "una foto subida es más chica que el mínimo de Mercado Libre",
  },
];

/** Fotos subidas que Mercado Libre no acepta al usarlas en un ítem: se suben de nuevo una vez. */
export const MERCADOLIBRE_PICTURE_ID_CAUSES: readonly number[] = [508, 509];

/**
 * Una causa en español: la de la tabla (por `code`; por `cause_id` si no vino código o si es 508
 * o 509), la del contacto, o el código tal cual. Un `cause_id` no manda sobre un código desconocido:
 * los ids podrían repetirse entre códigos distintos.
 */
export function describeCause(cause: MercadoLibreCause): string {
  const byId =
    cause.causeId !== null &&
    (cause.code === null || MERCADOLIBRE_PICTURE_ID_CAUSES.includes(cause.causeId));
  const known =
    CAUSE_MESSAGES.find((entry) => cause.code !== null && entry.codes.includes(cause.code)) ??
    (byId ? CAUSE_MESSAGES.find((entry) => entry.ids.includes(cause.causeId ?? -1)) : undefined);
  if (known) return known.text;
  if (cause.code?.startsWith("seller_contact.")) {
    return "falta el contacto del corredor o está mal escrito (WhatsApp)";
  }
  return `otra causa (${cause.code ?? cause.causeId ?? "sin código"})`;
}

/** Una causa sin `type` cuenta como error: dejar pasar un rechazo sería peor. */
export const isBlockingCause = (cause: MercadoLibreCause) => cause.type !== "warning";

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
    case "invalid_operator_user_id":
      return error(
        "ML_PERMISSION_DENIED",
        "Se autorizó con un colaborador: conecta de nuevo con la cuenta administradora de Mercado Libre",
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
  // 408 y 425: Mercado Libre no alcanzó a atender la petición; reintentar es seguro.
  if (httpStatus !== null && (httpStatus >= 500 || httpStatus === 408 || httpStatus === 425)) {
    return unavailable(info);
  }
  const blocking = info.causes.filter(isBlockingCause);
  if (httpStatus !== null && httpStatus >= 400 && blocking.length > 0) {
    const reasons = [...new Set(blocking.map(describeCause))];
    return error(
      "ML_ITEM_REJECTED",
      `Mercado Libre rechazó el aviso: ${reasons.join("; ")}`,
      false,
      info,
    );
  }
  // Un 402 sin causas que bloqueen (con causas, es un rechazo del aviso, arriba): lo vio `ml:smoke`
  // el 2026-10-08 en `POST /items/validate` con una cuenta sin paquetes (`classifieds_promotion_packs`
  // respondía 404), después de revisar el título (un título largo dio 400 con su causa). Que 402 sea
  // "sin cupo" es INFERENCIA: lo confirma la demo con el paquete contratado (T23).
  if (httpStatus === 402) {
    return error(
      "ML_NO_QUOTA",
      "Mercado Libre pide un pago (402): probablemente la cuenta no tiene un paquete de publicación con cupo; revísalo en Mercado Libre",
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

/**
 * ¿El error trae alguna de estas causas que bloquean (`cause_id`)? Lo usa el publisher para
 * reconocer 508 y 509 (`MERCADOLIBRE_PICTURE_ID_CAUSES`) sin leer `details` a mano.
 */
export function hasMercadoLibreCause(error: unknown, causeIds: readonly number[]): boolean {
  return mercadoLibreCausesOf(error).some(
    (cause) => isBlockingCause(cause) && cause.causeId !== null && causeIds.includes(cause.causeId),
  );
}

const storedCauseSchema = z.object({
  code: z.string().nullable(),
  causeId: z.number().int().nullable(),
  type: z.string().nullable(),
});

/**
 * Las causas que `mercadoLibreError` guardó en los detalles de un `AppError`, revisadas (no un
 * cast): `[]` si no es un `AppError` o si sus detalles no tienen esa forma.
 */
export function mercadoLibreCausesOf(error: unknown): MercadoLibreCause[] {
  if (!isAppError(error)) return [];
  const parsed = z.array(storedCauseSchema).safeParse(error.details?.causes);
  return parsed.success ? parsed.data : [];
}

/**
 * Después de un `POST /items` que falló (spec F4 §4.8): `not_created` si Mercado Libre respondió
 * un 4xx (salvo 408 y 425, que no atendió) o si el pedido no se envió (cuerpo o token inválidos):
 * se puede corregir y crear de nuevo. `unknown` en lo demás (5xx, 408, 425, red, tope, señal o un
 * 2xx con otra forma): el ítem **pudo** crearse y se busca antes de repetir (nunca a ciegas).
 */
export function itemCreationOutcome(error: unknown): "not_created" | "unknown" {
  if (!isAppError(error)) return "unknown";
  const details = (error.details ?? {}) as { httpStatus?: unknown; reason?: unknown };
  if (
    error.code === "ML_BODY_INVALID" ||
    details.reason === "token_malformed" ||
    details.reason === "not_sent"
  ) {
    return "not_created";
  }
  const status = details.httpStatus;
  return typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 425
    ? "not_created"
    : "unknown";
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
  aborted: (when: "before_send" | "in_flight" = "in_flight") =>
    new AppError("ML_ABORTED", "Se cortó la llamada a Mercado Libre", {
      retriable: true,
      // Cortada antes de enviarse: Mercado Libre no la recibió (`itemCreationOutcome`).
      ...(when === "before_send" ? { details: { reason: "not_sent" } } : {}),
    }),
  /** Un token que no puede ir en una cabecera ni en un formulario (por ejemplo, con un salto de línea). */
  malformedToken: () =>
    new AppError(
      "ML_AUTH_INVALID",
      "El acceso guardado de Mercado Libre no es válido: reconecta la cuenta",
      { details: { reason: "token_malformed" } },
    ),
  /**
   * Un id que va en la dirección de la llamada (ítem, usuario o el estado de una búsqueda) con una
   * forma que no es la de Mercado Libre: no se llama, para no armar otra ruta. El valor no va en el
   * error.
   */
  invalidId: (kind: "item" | "user" | "category" | "location" | "status") =>
    new AppError("ML_ID_INVALID", "El id guardado de Mercado Libre no es válido", {
      details: { kind },
    }),
  /** Un cuerpo que no se puede convertir a JSON (por ejemplo, un `BigInt`): no se envía. */
  invalidBody: (call: string) =>
    new AppError("ML_BODY_INVALID", "No se pudo armar el pedido a Mercado Libre", {
      details: { call },
    }),
  /** Una foto vacía o de un tipo que Mercado Libre no acepta (JPEG o PNG, nota §5): no se sube. */
  invalidPicture: (reason: "empty" | "type") =>
    new AppError(
      "ML_PICTURE_INVALID",
      reason === "empty"
        ? "La foto está vacía: revisa el archivo y prepara de nuevo"
        : "Mercado Libre solo acepta fotos JPEG o PNG",
      { details: { reason } },
    ),
  /** Un estado que el cliente no escribe (solo pausar, reactivar o cerrar): nunca se envía. */
  statusNotAllowed: () =>
    new AppError(
      "ML_STATUS_NOT_ALLOWED",
      "Ese cambio de estado no está permitido en Mercado Libre",
    ),
  /**
   * No se sabe si `POST /items` creó el ítem y la búsqueda por `seller_custom_field` no lo aclara
   * (ninguno o más de uno, spec F4 §4.8): no se reintenta, porque crear de nuevo gastaría otro cupo.
   */
  publishOutcomeUnknown: (found: "none" | "many") =>
    new AppError(
      "ML_PUBLISH_OUTCOME_UNKNOWN",
      found === "none"
        ? "No se sabe si el aviso se creó en Mercado Libre: revisa la cuenta. Si no está, descarta la publicación y vuelve a publicar; si está, ciérralo a mano antes de volver a publicar"
        : "Hay más de un aviso de esta publicación en Mercado Libre: revisa la cuenta y cierra a mano los que sobren antes de seguir",
      { details: { found } },
    ),
  /** Una respuesta con otra forma: reintentar no la cambia. */
  unexpectedResponse: (call: string) =>
    new AppError("ML_UNEXPECTED_RESPONSE", "Mercado Libre respondió algo inesperado", {
      details: { call },
    }),
} as const;
