import { brokerListResponseSchema } from "@agentsales/api/contracts";
import { type Broker, slugify } from "@agentsales/core";
import { type ApiClient, unwrap } from "../api-client.js";
import { CliError } from "../output.js";

/** Lo que usan varios comandos. */

/** `--broker` como slug (`Mi-Corredor` → `mi-corredor`), igual que el que sale de la hoja. */
export function brokerSlugOf(broker: string): string {
  const slug = slugify(broker);
  if (slug === "") {
    throw new CliError("BROKER_INVALID", `--broker "${broker}" no tiene letras ni números`);
  }
  return slug;
}

/** Los corredores por id, para mostrar de quién es cada aviso. */
export async function fetchBrokers(client: ApiClient): Promise<Map<string, Broker>> {
  const { brokers } = await unwrap(client.brokers.$get(), brokerListResponseSchema);
  return new Map(brokers.map((broker) => [broker.id, broker]));
}
