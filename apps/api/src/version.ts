import { readProductVersion } from "@agentsales/config";

/**
 * La versión de la API: la de AgentSales, del `package.json` raíz (spec F9.5 §4.2). `server.ts` la
 * lee una vez al arrancar; va en `/health` y en la cabecera `X-AgentSales-Version`.
 */
export function readApiVersion(): string {
  return readProductVersion();
}
