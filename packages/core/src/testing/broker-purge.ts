import { AppError } from "../errors.js";
import type {
  BrokerPurgeBlocker,
  BrokerPurgeCounts,
  BrokerPurgeDeleted,
  BrokerPurgeOutcome,
  BrokerPurgeRepository,
  BrokerStorageRefs,
} from "../ports/broker-purge-repository.js";
import { brokerHasActivePublications } from "../use-cases/purge-broker.js";

/** Lo que el doble sabe de un corredor: sus cifras, lo que impide borrarlo y sus claves de R2. */
export type FakeBrokerPurgeData = {
  counts?: Partial<BrokerPurgeCounts>;
  blocking?: BrokerPurgeBlocker[];
  refs?: Partial<BrokerStorageRefs>;
  /** Lo que devuelve `purge` (por defecto, una fila de `brokers`). */
  deleted?: BrokerPurgeDeleted;
  /**
   * Los posts y las cargas que `purge` dice haber borrado (por defecto, los de `refs`): uno que no
   * está en `refs` simula uno creado entre la lectura de las claves y la transacción.
   */
  purgedIds?: Partial<Pick<BrokerPurgeOutcome, "postIds" | "importRunIds">>;
  /** Un error para `purge` (por ejemplo, la base caída): no se borra nada. */
  failPurge?: AppError;
};

export type FakeBrokerPurgeRepository = BrokerPurgeRepository & {
  /** Fija los datos de un corredor. */
  set(brokerId: string, data: FakeBrokerPurgeData): void;
  /** Los corredores ya borrados. */
  purged: string[];
  /** Cada llamada en orden (`summarize:<id>`, `storageRefs:<id>`, `purge:<id>`). */
  calls: string[];
};

const ZERO: BrokerPurgeCounts = {
  listings: 0,
  media: 0,
  publications: 0,
  livePublications: 0,
  posts: 0,
  users: 0,
  accounts: 0,
  importRuns: 0,
};

/**
 * Doble de `BrokerPurgeRepository` (F9.5-T14) para el caso de uso y las rutas: no mira otros
 * repositorios (lo que borra de verdad lo prueba el de Drizzle con PGlite). `onPurge` deja que el
 * test quite el corredor de su doble de corredores.
 */
export function createFakeBrokerPurgeRepository(
  options: { onPurge?: (brokerId: string) => void | Promise<void> } = {},
): FakeBrokerPurgeRepository {
  const data = new Map<string, FakeBrokerPurgeData>();
  const purged: string[] = [];
  const calls: string[] = [];
  const of = (brokerId: string) => data.get(brokerId) ?? {};
  return {
    purged,
    calls,
    set(brokerId, value) {
      data.set(brokerId, value);
    },
    async summarize(brokerId) {
      calls.push(`summarize:${brokerId}`);
      const { counts, blocking } = of(brokerId);
      return { counts: { ...ZERO, ...counts }, blocking: [...(blocking ?? [])] };
    },
    async storageRefs(brokerId) {
      calls.push(`storageRefs:${brokerId}`);
      const { refs } = of(brokerId);
      return {
        mediaKeys: [...(refs?.mediaKeys ?? [])],
        uploadKeys: [...(refs?.uploadKeys ?? [])],
        postIds: [...(refs?.postIds ?? [])],
        importRunIds: [...(refs?.importRunIds ?? [])],
      };
    },
    async purge(brokerId) {
      calls.push(`purge:${brokerId}`);
      const entry = of(brokerId);
      if (purged.includes(brokerId)) {
        throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${brokerId}`);
      }
      if (entry.failPurge !== undefined) throw entry.failPurge;
      if ((entry.blocking ?? []).length > 0) {
        throw brokerHasActivePublications(entry.blocking ?? []);
      }
      purged.push(brokerId);
      await options.onPurge?.(brokerId);
      return {
        deleted: { ...(entry.deleted ?? { brokers: 1 }) },
        postIds: [...(entry.purgedIds?.postIds ?? entry.refs?.postIds ?? [])],
        importRunIds: [...(entry.purgedIds?.importRunIds ?? entry.refs?.importRunIds ?? [])],
      };
    },
  };
}
