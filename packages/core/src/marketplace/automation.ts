import type { Broker } from "../broker.js";
import { AppError } from "../errors.js";

/**
 * El formulario automático de Marketplace (el perfil del navegador en el Mac del operador) es solo
 * para los corredores **propios** del operador (spec F7 §4.8, ADR-0023 punto 4): cubre conectar la
 * cuenta, `marketplace.profile`, `fb:smoke --listing` y publicar con una cuenta de perfil. Los
 * demás usan la cuenta a mano. `MARKETPLACE_AUTOMATION_NOT_ALLOWED` (403) si no es propio.
 */
export function assertMarketplaceAutomationAllowed(
  broker: Pick<Broker, "operatorOwned" | "slug">,
): void {
  if (broker.operatorOwned) return;
  throw new AppError(
    "MARKETPLACE_AUTOMATION_NOT_ALLOWED",
    `El formulario automático de Marketplace es solo para tus corredores: ${broker.slug} publica a mano (activa su cuenta a mano)`,
    { details: { broker: broker.slug } },
  );
}
