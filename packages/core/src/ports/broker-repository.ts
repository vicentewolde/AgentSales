import type { Broker, BrokerData } from "../broker.js";

/**
 * Corredores (`brokers`). Decidir si hay que actualizar (`brokerDiffers`) es del caso de uso.
 * Los errores de conexión son `AppError("DB_UNAVAILABLE", { retriable: true })`.
 */
export interface BrokerRepository {
  findBySlug(slug: string): Promise<Broker | null>;
  create(data: BrokerData): Promise<Broker>;
  /** Actualiza los datos de la hoja Corredor; no toca `logoMediaId` ni `autoPublish`. */
  update(id: string, data: BrokerData): Promise<Broker>;
}
