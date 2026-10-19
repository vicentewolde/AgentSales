import type { Broker } from "../broker.js";
import { AppError } from "../errors.js";

/**
 * El formulario automático de Marketplace (el perfil del navegador en el Mac del operador) es solo
 * para los corredores **propios** del operador (spec F7 §4.8, ADR-0023 punto 4) y solo donde el
 * ambiente lo permite: **no corre en producción** (spec F8 §4.10, D4, ADR-0024: sin perfiles ni
 * Chromium con ventana en el servidor; allí todos publican a mano). Cubre conectar la cuenta,
 * `marketplace.profile`, `fb:smoke --listing` y publicar con una cuenta de perfil. Los demás usan la
 * cuenta a mano. `MARKETPLACE_AUTOMATION_NOT_ALLOWED` (403) si no se puede.
 *
 * `automationEnabled` es lo que el ambiente permite (`marketplaceAutomationEnabled` de config: todo
 * menos `NODE_ENV=production`); core no lo lee, lo recibe.
 */
export const marketplaceAutomationAllowed = (
  broker: Pick<Broker, "operatorOwned">,
  automationEnabled: boolean,
): boolean => automationEnabled && broker.operatorOwned;

export function assertMarketplaceAutomationAllowed(
  broker: Pick<Broker, "operatorOwned" | "slug">,
  automationEnabled: boolean,
): void {
  if (marketplaceAutomationAllowed(broker, automationEnabled)) return;
  throw new AppError(
    "MARKETPLACE_AUTOMATION_NOT_ALLOWED",
    automationEnabled
      ? `El formulario automático de Marketplace es solo para tus corredores: ${broker.slug} publica a mano (activa su cuenta a mano)`
      : `En el servidor Marketplace se publica a mano, sin el formulario automático: activa la cuenta a mano de ${broker.slug}`,
    { details: { broker: broker.slug, environmentAllows: automationEnabled } },
  );
}
