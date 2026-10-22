import { readProductVersion } from "@agentsales/config";

/**
 * La versión de la CLI: la de AgentSales, del `package.json` raíz (spec F9.5 §4.2), la misma que
 * informa la API en `X-AgentSales-Version`. Se lee una vez por comando.
 */
export function readCliVersion(): string {
  return readProductVersion();
}
