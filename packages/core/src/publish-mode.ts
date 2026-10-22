import type { Broker } from "./broker.js";
import type { PublishMode } from "./enums.js";
import type { BrokerRepository } from "./ports/broker-repository.js";

/**
 * Lo que `effectivePublishMode` mira de un corredor o una marca: las dos condiciones de la segunda
 * llave (ADR-0036).
 */
export type PublishModeBroker = Pick<Broker, "liveEnabled" | "operatorOwned">;

/**
 * **La única fuente del modo de una publicación** (F9.5-T22, ADR-0036): sale de verdad (`live`)
 * solo si el servidor está en `PUBLISH_MODE=live` **y** la marca tiene `live_enabled` **y** es propia
 * del operador (`operator_owned`). Con cualquiera de las tres cosas apagada, es `dry-run`.
 *
 * Nada más en core, la API ni el worker decide el modo de una publicación a partir de
 * `PUBLISH_MODE`: un test recorre el código fuente y falla si encuentra otra lectura.
 */
export function effectivePublishMode(
  serverMode: PublishMode,
  broker: PublishModeBroker,
): PublishMode {
  return serverMode === "live" && broker.liveEnabled && broker.operatorOwned ? "live" : "dry-run";
}

/** `effectivePublishMode(...) === "dry-run"`: el `dryRun` que se fija en una publicación. */
export const effectiveDryRun = (serverMode: PublishMode, broker: PublishModeBroker): boolean =>
  effectivePublishMode(serverMode, broker) === "dry-run";

/**
 * El modo del corredor `brokerId` (por id). Un corredor que no existe es `dry-run`: ante la duda,
 * simulación.
 */
export async function brokerPublishMode(
  deps: { brokers: Pick<BrokerRepository, "findById"> },
  serverMode: PublishMode,
  brokerId: string,
): Promise<PublishMode> {
  // Sin el servidor en `live` ninguna marca publica de verdad: ni se busca.
  if (serverMode !== "live") return "dry-run";
  const broker = await deps.brokers.findById(brokerId);
  return broker === null ? "dry-run" : effectivePublishMode(serverMode, broker);
}

/**
 * Las marcas que están encendidas en vivo (`liveEnabled` y propias), sin mirar el servidor: para el
 * estado de la CLI y el banner de «Todos».
 */
export const liveEnabledBrokers = <T extends PublishModeBroker>(brokers: readonly T[]): T[] =>
  brokers.filter((broker) => broker.liveEnabled && broker.operatorOwned);
