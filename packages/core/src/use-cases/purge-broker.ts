import type { Broker } from "../broker.js";
import { postObjectsPrefix } from "../content/media-keys.js";
import type { PublicationStatus } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import { assertCan } from "../permissions.js";
import type {
  BrokerPurgeBlocker,
  BrokerPurgeCounts,
  BrokerPurgeDeleted,
  BrokerPurgeRepository,
  BrokerStorageRefs,
} from "../ports/broker-purge-repository.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { MediaStorage } from "../ports/media-storage.js";
import type { User } from "../user.js";
import { importObjectsPrefix } from "./request-import.js";

// Borrar un corredor de verdad (spec F9.5-T14, ADR-0035): todo lo suyo en una transacción y, después
// del commit, sus archivos en R2 por sus claves. No borra nada en las redes: lo publicado sigue allá.

/**
 * Lo que impide borrar: algo publicándose (también el formulario o la red a mano que espera el clic
 * final), programado o con resultado dudoso. Se cancela, se confirma o se resuelve antes.
 */
export const PURGE_BLOCKING_PUBLICATION_STATUSES = [
  "publishing",
  "scheduled",
  "awaiting_manual_confirm",
  "outcome_unknown",
] as const satisfies readonly PublicationStatus[];

export const isPurgeBlockingStatus = (status: PublicationStatus): boolean =>
  (PURGE_BLOCKING_PUBLICATION_STATUSES as readonly PublicationStatus[]).includes(status);

/** `BROKER_HAS_ACTIVE_PUBLICATIONS` (409), con el consejo de qué hacer con cada una. */
export function brokerHasActivePublications(blocking: readonly BrokerPurgeBlocker[]): AppError {
  return new AppError(
    "BROKER_HAS_ACTIVE_PUBLICATIONS",
    `El corredor tiene ${blocking.length} ${blocking.length === 1 ? "publicación" : "publicaciones"} en curso, programadas o con resultado dudoso: desprograma o cancela las programadas, confirma o di «no lo publiqué» en las que esperan, y resuelve las dudosas antes de borrarlo`,
    { details: { publicationIds: blocking.map(({ publicationId }) => publicationId) } },
  );
}

/** Cuántos objetos de R2 se borran a la vez (un `DELETE` por objeto). */
export const PURGE_STORAGE_BATCH = 16;
/** Cuántas claves pendientes vuelven en la respuesta; el log las anota todas. */
export const PURGE_PENDING_SHOWN = 50;

export type BrokerPurgeSummary = {
  broker: Pick<Broker, "id" | "slug" | "brandName" | "kind">;
  counts: BrokerPurgeCounts;
  blocking: BrokerPurgeBlocker[];
};

/** Lo que R2 no pudo borrar: la clave o el prefijo y el código del error (nunca una URL). */
export type PurgeStorageFailure =
  | { kind: "key"; key: string; code: string }
  | { kind: "prefix"; prefix: string; code: string };

export type BrokerPurgeResult = {
  broker: Pick<Broker, "id" | "slug">;
  /** Filas borradas por tabla. */
  deleted: BrokerPurgeDeleted;
  storage: {
    /** Objetos borrados en R2 (o que ya no estaban). */
    deleted: number;
    /** Cuántos quedaron pendientes (claves y prefijos que no se pudieron recorrer). */
    pendingCount: number;
    /** Hasta `PURGE_PENDING_SHOWN` de ellos; el log del servidor los tiene todos. */
    pending: PurgeStorageFailure[];
  };
};

export type PurgeBrokerDeps = {
  brokers: Pick<BrokerRepository, "findById">;
  brokerPurge: BrokerPurgeRepository;
  storage: Pick<MediaStorage, "list" | "delete">;
  /** Cada cosa que R2 no borró, para el log (se reintenta a mano, ADR-0035). */
  onStorageFailure?: (failure: PurgeStorageFailure) => void;
};

type Actor = Pick<User, "role" | "brokerId">;

async function brokerOf(deps: Pick<PurgeBrokerDeps, "brokers">, id: string): Promise<Broker> {
  const broker = await deps.brokers.findById(id);
  if (broker === null) {
    throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${id}`, { details: { id } });
  }
  return broker;
}

/** El resumen de lo que se borraría (solo el administrador: `brokers.delete`). No cambia nada. */
export async function purgeBrokerSummary(
  deps: Pick<PurgeBrokerDeps, "brokers" | "brokerPurge">,
  actor: Actor,
  brokerId: string,
): Promise<BrokerPurgeSummary> {
  assertCan(actor, "brokers.delete");
  const broker = await brokerOf(deps, brokerId);
  const { counts, blocking } = await deps.brokerPurge.summarize(broker.id);
  return {
    broker: { id: broker.id, slug: broker.slug, brandName: broker.brandName, kind: broker.kind },
    counts,
    blocking,
  };
}

const codeOf = (error: unknown) => (isAppError(error) ? error.code : "STORAGE_ERROR");

/**
 * Borra en R2 por lista de claves, después del commit: las de la base y lo que haya bajo los
 * prefijos del corredor, de sus posts y de sus cargas (un archivo que la base ya no nombraba, como
 * un logo anterior). Nada de esto revierte la base: lo que falle queda anotado.
 */
async function removeObjects(
  deps: Pick<PurgeBrokerDeps, "storage" | "onStorageFailure">,
  brokerId: string,
  refs: BrokerStorageRefs,
): Promise<BrokerPurgeResult["storage"]> {
  const failures: PurgeStorageFailure[] = [];
  const fail = (failure: PurgeStorageFailure) => {
    failures.push(failure);
    deps.onStorageFailure?.(failure);
  };
  const keys = new Set([...refs.mediaKeys, ...refs.uploadKeys]);
  const prefixes = [
    `brokers/${brokerId}/`,
    ...refs.postIds.map(postObjectsPrefix),
    ...refs.importRunIds.map(importObjectsPrefix),
  ];
  for (const prefix of prefixes) {
    try {
      for (const object of await deps.storage.list(prefix)) keys.add(object.path);
    } catch (error) {
      fail({ kind: "prefix", prefix, code: codeOf(error) });
    }
  }
  const all = [...keys].sort();
  let deleted = 0;
  for (let start = 0; start < all.length; start += PURGE_STORAGE_BATCH) {
    const batch = all.slice(start, start + PURGE_STORAGE_BATCH);
    const results = await Promise.allSettled(batch.map((key) => deps.storage.delete(key)));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") deleted += 1;
      else fail({ kind: "key", key: batch[index] ?? "", code: codeOf(result.reason) });
    });
  }
  return {
    deleted,
    pendingCount: failures.length,
    pending: failures.slice(0, PURGE_PENDING_SHOWN),
  };
}

/**
 * Borra un corredor y todo lo suyo (spec F9.5-T14, ADR-0035), solo el administrador
 * (`brokers.delete`) y con `confirm` igual a su `slug` (si no, `BROKER_DELETE_NOT_CONFIRMED`, 409).
 * Se niega con `BROKER_HAS_ACTIVE_PUBLICATIONS` si algo se publica, está programado, espera el clic
 * o tiene resultado dudoso. Junta las claves de R2 **antes**, borra la base en una transacción y,
 * **después** del commit, los archivos: un fallo de R2 no revierte la base y queda en `pending`.
 */
export async function purgeBroker(
  deps: PurgeBrokerDeps,
  actor: Actor,
  input: { brokerId: string; confirm: string },
): Promise<BrokerPurgeResult> {
  assertCan(actor, "brokers.delete");
  const broker = await brokerOf(deps, input.brokerId);
  if (input.confirm.trim() !== broker.slug) {
    throw new AppError(
      "BROKER_DELETE_NOT_CONFIRMED",
      `Para borrar el corredor escribe su identificador exacto: ${broker.slug}`,
      { details: { slug: broker.slug } },
    );
  }
  const { blocking } = await deps.brokerPurge.summarize(broker.id);
  if (blocking.length > 0) throw brokerHasActivePublications(blocking);
  const refs = await deps.brokerPurge.storageRefs(broker.id);
  const deleted = await deps.brokerPurge.purge(broker.id);
  const storage = await removeObjects(deps, broker.id, refs);
  return { broker: { id: broker.id, slug: broker.slug }, deleted, storage };
}
