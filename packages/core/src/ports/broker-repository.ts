import type { Broker, BrokerData } from "../broker.js";

/**
 * Corredores (`brokers`), únicos por `slug`. Decidir si hay que actualizar es del caso de uso.
 * Errores (`AppError`):
 * - `create` con un `slug` que ya existe → `BROKER_CONFLICT`, **reintentable**: dos intentos del
 *   job pueden solaparse, y el reintento lo encuentra y sale `unchanged` o `updated`;
 * - `update` de un id que no existe → `BROKER_NOT_FOUND`;
 * - fallo de conexión → `DB_UNAVAILABLE`, reintentable.
 * La ingesta de medios (F1-T07) suma `setLogo(id, mediaId)`.
 */
export interface BrokerRepository {
  findBySlug(slug: string): Promise<Broker | null>;
  create(data: BrokerData): Promise<Broker>;
  /** Actualiza los datos de la hoja Corredor; no toca `logoMediaId` ni `autoPublish`. */
  update(id: string, data: BrokerData): Promise<Broker>;
}
