import { isAppError } from "@agentsales/core";
import { MERCADOLIBRE_API_ORIGIN, MERCADOLIBRE_REQUEST_TIMEOUT_MS } from "./constants.js";
import { describeCause, MAX_CAUSES, type MercadoLibreCause, parseCauses } from "./errors.js";
import {
  type MercadoLibreCallOptions,
  type MercadoLibreHttpOptions,
  mercadoLibreRequest,
} from "./http.js";
import type { MercadoLibreItemBody } from "./items.js";

/**
 * Lo que dijo Mercado Libre de un aviso sin crearlo (`POST /items/validate`, nota §4.1):
 * - `valid: true`: `204` (o un 2xx), con las advertencias que trajera;
 * - `valid: false`: un 4xx con al menos una causa que bloquea; `reasons` las explica en español
 *   (sin el `message` de Mercado Libre ni datos del aviso) y `warnings` trae las que no bloquean.
 */
export type MercadoLibreValidation =
  | { valid: true; warnings: MercadoLibreCause[] }
  | {
      valid: false;
      errors: MercadoLibreCause[];
      warnings: MercadoLibreCause[];
      reasons: string[];
    };

/**
 * `POST /items/validate` con el mismo cuerpo que `POST /items` (nota §4.1): revisa categoría,
 * atributos, moneda, ubicación, contacto y título **sin crear nada ni gastar cupo** (ADR-0016: se
 * permite en `dry-run`). Un rechazo del aviso es un resultado, no un error: es justo lo que se
 * pregunta. Los demás errores (token, permiso, red, tope, 5xx, un 400 sin causas que bloqueen) se
 * lanzan como `ML_*`, igual que las otras llamadas.
 */
export interface MercadoLibreValidator {
  validate(
    accessToken: string,
    body: MercadoLibreItemBody,
    options?: MercadoLibreCallOptions,
  ): Promise<MercadoLibreValidation>;
}

/**
 * Las causas de un rechazo del aviso: un `ML_ITEM_REJECTED` (un 4xx con al menos una causa que
 * bloquea, `mercadoLibreError`), con las causas ya leídas en sus detalles. `null` en otro error.
 */
function rejectionCauses(error: unknown): MercadoLibreCause[] | null {
  if (!isAppError(error) || error.code !== "ML_ITEM_REJECTED") return null;
  const causes = error.details?.causes;
  return Array.isArray(causes) ? (causes as MercadoLibreCause[]) : null;
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
        const causes = rejectionCauses(error);
        if (causes === null) throw error;
        const errors = causes.filter((cause) => cause.type !== "warning");
        const warnings = causes.filter((cause) => cause.type === "warning");
        return {
          valid: false,
          errors,
          warnings,
          reasons: [...new Set(errors.map(describeCause))],
        };
      }
      // `204` llega vacío; si algún día trae cuerpo, se rescatan sus advertencias.
      const record =
        typeof response === "object" && response !== null
          ? (response as Record<string, unknown>)
          : {};
      const warnings = [...parseCauses(record.warnings), ...parseCauses(record.cause)]
        .filter((cause) => cause.type !== "error")
        .slice(0, MAX_CAUSES);
      return { valid: true, warnings };
    },
  };
}
