import { isAppError } from "@agentsales/core";
import { MERCADOLIBRE_API_ORIGIN, MERCADOLIBRE_REQUEST_TIMEOUT_MS } from "./constants.js";
import {
  describeCause,
  isBlockingCause,
  MAX_CAUSES,
  MERCADOLIBRE_ERRORS,
  type MercadoLibreCause,
  mercadoLibreCausesOf,
  parseCauses,
} from "./errors.js";
import {
  type MercadoLibreCallOptions,
  type MercadoLibreHttpOptions,
  mercadoLibreRequest,
} from "./http.js";
import type { MercadoLibreItemBody } from "./items.js";

/**
 * Un motivo de rechazo, con la forma de `PublishIssue` de core (`{ code, message }`): `code` es el
 * código de Mercado Libre (o `cause_<id>` si solo vino el id) y `message`, la causa en español
 * (`describeCause`), sin el `message` de Mercado Libre ni datos del aviso.
 */
export type MercadoLibreValidationIssue = { code: string; message: string };

/**
 * Lo que dijo Mercado Libre de un aviso sin crearlo (`POST /items/validate`, nota §4.1):
 * - `valid: true`: `204` (o un 2xx sin causas que bloqueen), con las advertencias que trajera;
 * - `valid: false`: un 400 o 422 con al menos una causa que bloquea; `issues` las explica (sin
 *   repetir) y `warnings` trae las que no bloquean.
 */
export type MercadoLibreValidation =
  | { valid: true; warnings: MercadoLibreCause[] }
  | {
      valid: false;
      errors: MercadoLibreCause[];
      warnings: MercadoLibreCause[];
      issues: MercadoLibreValidationIssue[];
    };

/**
 * `POST /items/validate` con el mismo cuerpo que `POST /items` (nota §4.1): revisa categoría,
 * atributos, moneda, ubicación, contacto y título sin crear nada ni gastar cupo (INFERENCIA de la
 * nota §8; `ml:smoke` lo confirma). ADR-0016 lo permite en `dry-run`. Un rechazo del aviso es un
 * resultado, no un error: es justo lo que se pregunta. Los demás errores (token, permiso, límite,
 * red, tope, 5xx, otro 4xx, un 400 sin causas que bloqueen) se lanzan como `ML_*`, igual que las
 * otras llamadas.
 */
export interface MercadoLibreValidator {
  validate(
    accessToken: string,
    body: MercadoLibreItemBody,
    options?: MercadoLibreCallOptions,
  ): Promise<MercadoLibreValidation>;
}

/** Un rechazo del aviso: un 400 o 422 que `mercadoLibreError` clasificó como `ML_ITEM_REJECTED`. */
function isItemRejection(error: unknown): boolean {
  if (!isAppError(error) || error.code !== "ML_ITEM_REJECTED") return false;
  const status = error.details?.httpStatus;
  return status === 400 || status === 422;
}

/** Los motivos, sin repetir: uno por código (o por id, si no vino código). */
function issuesOf(errors: readonly MercadoLibreCause[]): MercadoLibreValidationIssue[] {
  const issues = new Map<string, MercadoLibreValidationIssue>();
  for (const cause of errors) {
    const code = cause.code ?? (cause.causeId === null ? "unknown" : `cause_${cause.causeId}`);
    if (!issues.has(code)) issues.set(code, { code, message: describeCause(cause) });
  }
  return [...issues.values()];
}

export function createMercadoLibreValidator(
  options: MercadoLibreHttpOptions = {},
): MercadoLibreValidator {
  const origin = options.origin ?? MERCADOLIBRE_API_ORIGIN;
  const timeoutMs = options.timeoutMs ?? MERCADOLIBRE_REQUEST_TIMEOUT_MS;

  return {
    async validate(accessToken, body, { signal } = {}) {
      let response: unknown;
      try {
        response = await mercadoLibreRequest(
          "validateItem",
          new URL("/items/validate", origin),
          { method: "POST", accessToken, body: { json: body } },
          { signal, timeoutMs },
        );
      } catch (error) {
        if (!isItemRejection(error)) throw error;
        const causes = mercadoLibreCausesOf(error);
        const errors = causes.filter(isBlockingCause);
        return {
          valid: false,
          errors,
          warnings: causes.filter((cause) => !isBlockingCause(cause)),
          issues: issuesOf(errors),
        };
      }
      // `204` llega vacío. Si un 2xx trae cuerpo (forma no documentada, INFERENCIA), se rescatan
      // sus advertencias; una causa que bloquea en un 2xx no se declara válida.
      const record =
        typeof response === "object" && response !== null
          ? (response as Record<string, unknown>)
          : {};
      const causes = [...parseCauses(record.warnings), ...parseCauses(record.cause)];
      if (causes.some((cause) => cause.type === "error")) {
        throw MERCADOLIBRE_ERRORS.unexpectedResponse("validateItem");
      }
      return { valid: true, warnings: causes.slice(0, MAX_CAUSES) };
    },
  };
}
