import type { PublicationStatus } from "../enums.js";

// Borrar un corredor de verdad (spec F9.5-T14, ADR-0035): el repositorio cruza todas las tablas del
// corredor en una transacción, como excepción explícita (igual que el borrado a pedido de Meta,
// ADR-0027). Los archivos de R2 los borra el caso de uso después del commit.

/** Lo que se borraría, en cifras (el resumen que se muestra antes de confirmar). */
export type BrokerPurgeCounts = {
  listings: number;
  /** Todos los medios: originales, variantes, renders y el logo. */
  media: number;
  publications: number;
  posts: number;
  users: number;
  accounts: number;
  importRuns: number;
};

/** Una publicación que impide borrar (publicándose, programada, esperando el clic o dudosa). */
export type BrokerPurgeBlocker = {
  publicationId: string;
  status: PublicationStatus;
  platform: string;
};

/** Las claves de R2 del corredor, leídas de la base antes de borrar. */
export type BrokerStorageRefs = {
  /** `storage_path` de sus medios (originales, variantes, renders y logos). */
  mediaKeys: string[];
  /** `object_path` de las subidas de sus posts (puede que el archivo nunca haya llegado). */
  uploadKeys: string[];
  /** Sus posts y sus cargas: sus prefijos (`posts/{id}/`, `imports/{id}/`) se recorren en R2. */
  postIds: string[];
  importRunIds: string[];
};

/** Filas borradas por tabla (nombre de la tabla en la base → filas). */
export type BrokerPurgeDeleted = Record<string, number>;

export interface BrokerPurgeRepository {
  /** Las cifras y las publicaciones que lo impiden. No cambia nada. */
  summarize(
    brokerId: string,
  ): Promise<{ counts: BrokerPurgeCounts; blocking: BrokerPurgeBlocker[] }>;
  /** Las claves de R2 de sus medios y subidas, y los ids de sus posts y cargas. No cambia nada. */
  storageRefs(brokerId: string): Promise<BrokerStorageRefs>;
  /**
   * Borra el corredor y todo lo suyo **en una transacción**: toma la fila del corredor y sus
   * publicaciones, y si alguna impide borrar lanza `BROKER_HAS_ACTIVE_PUBLICATIONS` sin borrar nada
   * (vuelve a mirar dentro de la transacción: entre el resumen y el borrado pudo cambiar).
   * `BROKER_NOT_FOUND` si no existe. Los demás corredores no se tocan. Devuelve las filas borradas
   * por tabla (también las que se van en cascada: sesiones, invitaciones, códigos y bitácora).
   */
  purge(brokerId: string): Promise<BrokerPurgeDeleted>;
}
