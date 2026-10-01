import type { Broker, BrokerData } from "../broker.js";
import { AppError } from "../errors.js";
import type { ImportRun } from "../import-run.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { ImportRunRepository, NewImportRun } from "../ports/import-run-repository.js";
import type {
  ListingImportData,
  ListingImportRecord,
  ListingRepository,
  NewListing,
} from "../ports/listing-repository.js";

/** Ids legibles y deterministas para los tests (`broker-1`, `listing-2`…). */
function idGenerator(prefix: string) {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

export type InMemoryBrokerRepository = BrokerRepository & {
  all(): Broker[];
  /** Simula un cambio fuera de la hoja Corredor (panel), para probar que `update` no lo pisa. */
  setAutoPublish(id: string, autoPublish: boolean): void;
};

export function createInMemoryBrokerRepository(
  initial: readonly Broker[] = [],
): InMemoryBrokerRepository {
  const nextId = idGenerator("broker");
  const stored = new Map(initial.map((broker) => [broker.id, structuredCopy(broker)]));
  return {
    async findBySlug(slug) {
      const found = [...stored.values()].find((broker) => broker.slug === slug);
      return found === undefined ? null : structuredCopy(found);
    },
    async create(data: BrokerData) {
      if ([...stored.values()].some((broker) => broker.slug === data.slug)) {
        throw new AppError("BROKER_CONFLICT", `Ya existe el corredor ${data.slug}`, {
          retriable: true,
        });
      }
      const broker: Broker = {
        ...copyData(data),
        id: nextId(),
        logoMediaId: null,
        autoPublish: false,
      };
      stored.set(broker.id, broker);
      return structuredCopy(broker);
    },
    async update(id, data) {
      const current = stored.get(id);
      if (current === undefined) {
        throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${id}`);
      }
      const updated = { ...current, ...copyData(data) };
      stored.set(id, updated);
      return structuredCopy(updated);
    },
    async setLogo(id, mediaId) {
      const current = stored.get(id);
      if (current === undefined) {
        throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${id}`);
      }
      stored.set(id, { ...current, logoMediaId: mediaId });
    },
    all: () => [...stored.values()].map(structuredCopy),
    setAutoPublish(id, autoPublish) {
      const current = stored.get(id);
      if (current === undefined) throw new Error(`no existe el broker ${id}`);
      stored.set(id, { ...current, autoPublish });
    },
  };
}

/** Aviso guardado en memoria: lo que escribe la importación más su estado. */
export type StoredListing = NewListing & ListingImportRecord;

export type InMemoryListingRepository = ListingRepository & {
  all(): StoredListing[];
  /** Simula un cambio manual de estado (panel o CLI), para probar que reimportar no lo pisa. */
  setStatus(id: string, status: StoredListing["status"]): void;
};

export function createInMemoryListingRepository(): InMemoryListingRepository {
  const nextId = idGenerator("listing");
  const stored = new Map<string, StoredListing>();
  const record = (listing: StoredListing): ListingImportRecord => ({
    id: listing.id,
    externalRef: listing.externalRef,
    status: listing.status,
    sourceHash: listing.sourceHash,
  });
  return {
    async findByExternalRefs(brokerId, externalRefs) {
      return [...stored.values()]
        .filter(
          (listing) => listing.brokerId === brokerId && externalRefs.includes(listing.externalRef),
        )
        .map(record);
    },
    async create(listing) {
      const duplicate = [...stored.values()].some(
        (other) => other.brokerId === listing.brokerId && other.externalRef === listing.externalRef,
      );
      if (duplicate) {
        throw new AppError("LISTING_CONFLICT", `Ya existe el aviso ${listing.externalRef}`, {
          retriable: true,
        });
      }
      const created: StoredListing = { ...structuredCopy(listing), id: nextId(), status: "draft" };
      stored.set(created.id, created);
      return record(created);
    },
    async update(id, data: ListingImportData) {
      const current = stored.get(id);
      if (current === undefined)
        throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${id}`);
      // `status` no se toca: es del operador y de la ingesta de medios.
      const updated: StoredListing = { ...current, ...structuredCopy(data) };
      stored.set(id, updated);
      return record(updated);
    },
    async promoteToReady(id) {
      const current = stored.get(id);
      if (current?.status !== "draft") return false;
      stored.set(id, { ...current, status: "ready" });
      return true;
    },
    all: () => [...stored.values()].map(structuredCopy),
    setStatus(id, status) {
      const current = stored.get(id);
      if (current === undefined) throw new Error(`no existe el listing ${id}`);
      stored.set(id, { ...current, status });
    },
  };
}

export type InMemoryImportRunRepository = ImportRunRepository;

export function createInMemoryImportRunRepository(): InMemoryImportRunRepository {
  const nextId = idGenerator("run");
  const stored = new Map<string, ImportRun>();
  return {
    async create(run: NewImportRun) {
      const created: ImportRun = {
        id: nextId(),
        brokerId: null,
        status: "queued",
        dryRun: run.dryRun,
        source: run.source,
        fileName: run.fileName,
        input: structuredCopy(run.input),
        rowsTotal: 0,
        rowsCreated: 0,
        rowsUpdated: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        report: null,
        error: null,
        startedAt: null,
        finishedAt: null,
        createdAt: new Date(),
      };
      stored.set(created.id, created);
      return structuredCopy(created);
    },
    async get(id) {
      const run = stored.get(id);
      return run === undefined ? null : structuredCopy(run);
    },
    async recordListingsResult(id, { brokerId, counts, report }) {
      const current = stored.get(id);
      if (current === undefined) {
        throw new AppError("IMPORT_RUN_NOT_FOUND", `No existe la carga ${id}`);
      }
      stored.set(id, { ...current, brokerId, ...counts, report: structuredCopy(report) });
    },
    async recordMediaResult(id, report) {
      const current = stored.get(id);
      if (current === undefined) {
        throw new AppError("IMPORT_RUN_NOT_FOUND", `No existe la carga ${id}`);
      }
      stored.set(id, { ...current, report: structuredCopy(report) });
    },
  };
}

/** Copia profunda de datos planos (JSON más fechas): lo guardado no se comparte con quien llama. */
export function structuredCopy<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(structuredCopy) as T;
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, structuredCopy(item)]),
  ) as T;
}

function copyData(data: BrokerData): BrokerData {
  return structuredCopy(data);
}
