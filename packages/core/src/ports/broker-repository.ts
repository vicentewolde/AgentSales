import type { Broker, BrokerData } from "../broker.js";

/**
 * Corredores (`brokers`), únicos por `slug`. Decidir si hay que actualizar es del caso de uso.
 * Errores (`AppError`):
 * - `create` con un `slug` que ya existe → `BROKER_CONFLICT`, **reintentable**: dos intentos del
 *   job pueden solaparse, y el reintento lo encuentra y sale `unchanged` o `updated`;
 * - `update` de un id que no existe → `BROKER_NOT_FOUND`;
 * - fallo de conexión → `DB_UNAVAILABLE`, reintentable.
 * Los ids son uuid: la API los valida antes de llegar aquí (con otro formato, el adaptador de
 * Postgres da `DB_QUERY_FAILED`).
 */
export interface BrokerRepository {
  findBySlug(slug: string): Promise<Broker | null>;
  /** El corredor de un aviso (`listing.brokerId`, F2-T10); `null` si no existe. */
  findById(id: string): Promise<Broker | null>;
  /** Todos los corredores, por nombre de marca (para el selector de Importar). */
  list(): Promise<Broker[]>;
  create(data: BrokerData): Promise<Broker>;
  /** Actualiza los datos de la hoja Corredor; no toca `logoMediaId` ni `autoPublish`. */
  update(id: string, data: BrokerData): Promise<Broker>;
  /**
   * Fija el logo (F1-T07). `BROKER_NOT_FOUND` si el corredor no existe, y `MEDIA_NOT_FOUND` si el
   * medio no existe, es de otro corredor o es de un aviso (el logo es un original sin aviso).
   * Escribe aunque el logo no cambie: es idempotente.
   */
  setLogo(id: string, mediaId: string): Promise<void>;
}
