import type { Broker, BrokerData } from "../broker.js";
import { AppError } from "../errors.js";
import type { ImportRun } from "../import-run.js";
import type { Listing } from "../listing.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { ImportRunRepository, NewImportRun } from "../ports/import-run-repository.js";
import type {
  ListingImportData,
  ListingImportRecord,
  ListingRepository,
  NewListing,
} from "../ports/listing-repository.js";
import type { MediaRecord } from "../ports/media-repository.js";
import { structuredCopy } from "./copy.js";

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

export type InMemoryBrokerRepositoryOptions = {
  /**
   * Medios para validar `setLogo` como Postgres (que el medio exista, sea del corredor y no sea de
   * un aviso). Sin ellos, `setLogo` no valida el medio: solo sirve para tests que no lo ejercen.
   */
  media?: { all(): Pick<MediaRecord, "id" | "brokerId" | "listingId">[] };
};

export function createInMemoryBrokerRepository(
  initial: readonly Broker[] = [],
  options: InMemoryBrokerRepositoryOptions = {},
): InMemoryBrokerRepository {
  const nextId = idGenerator("broker");
  const stored = new Map(initial.map((broker) => [broker.id, structuredCopy(broker)]));
  return {
    async findBySlug(slug) {
      const found = [...stored.values()].find((broker) => broker.slug === slug);
      return found === undefined ? null : structuredCopy(found);
    },
    async list() {
      return [...stored.values()]
        .sort((a, b) => a.brandName.localeCompare(b.brandName, "es") || a.id.localeCompare(b.id))
        .map(structuredCopy);
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
      if (options.media !== undefined) {
        const logo = options.media.all().find((media) => media.id === mediaId);
        if (logo?.brokerId !== id || logo.listingId !== null) {
          throw new AppError("MEDIA_NOT_FOUND", `El medio ${mediaId} no es un logo del corredor`);
        }
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

export function createInMemoryListingRepository(
  options: { nextId?: () => string } = {},
): InMemoryListingRepository {
  // Por defecto, ids legibles (`listing-1`); la API valida uuid, así que sus tests dan los suyos.
  const nextId = options.nextId ?? idGenerator("listing");
  const stored = new Map<string, StoredListing>();
  // Fechas aparte, para no cambiar `StoredListing`. Un reloj que siempre avanza: dos escrituras
  // seguidas no empatan en `updatedAt`.
  const times = new Map<string, { createdAt: Date; updatedAt: Date }>();
  let clock = Date.UTC(2026, 0, 1);
  const tick = () => {
    clock += 1000;
    return new Date(clock);
  };
  const touch = (id: string) => {
    const now = tick();
    times.set(id, { createdAt: times.get(id)?.createdAt ?? now, updatedAt: now });
  };
  const entity = (listing: StoredListing): Listing => {
    const { sourceHash: _hash, ...rest } = structuredCopy(listing);
    const time = times.get(listing.id) ?? { createdAt: new Date(0), updatedAt: new Date(0) };
    return { ...rest, closeReason: null, createdAt: time.createdAt, updatedAt: time.updatedAt };
  };
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
      touch(created.id);
      return record(created);
    },
    async update(id, data: ListingImportData) {
      const current = stored.get(id);
      if (current === undefined)
        throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${id}`);
      // `status` no se toca: es del operador y de la ingesta de medios.
      const updated: StoredListing = { ...current, ...structuredCopy(data) };
      stored.set(id, updated);
      touch(id);
      return record(updated);
    },
    async promoteToReady(id) {
      const current = stored.get(id);
      if (current?.status !== "draft") return false;
      stored.set(id, { ...current, status: "ready" });
      touch(id);
      return true;
    },
    async list(filters = {}) {
      return [...stored.values()]
        .filter(
          (listing) =>
            (filters.status === undefined || listing.status === filters.status) &&
            (filters.operation === undefined || listing.operation === filters.operation) &&
            (filters.comuna === undefined || listing.comuna === filters.comuna),
        )
        .map(entity)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id));
    },
    async get(id) {
      const listing = stored.get(id);
      return listing === undefined ? null : entity(listing);
    },
    async changeStatus(id, from, to) {
      const current = stored.get(id);
      if (current?.status !== from) return false;
      stored.set(id, { ...current, status: to });
      touch(id);
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

export function createInMemoryImportRunRepository(
  options: { nextId?: () => string } = {},
): InMemoryImportRunRepository {
  // Por defecto, ids legibles (`run-1`); un test que pasa por el job (que exige uuid) da los suyos.
  const nextId = options.nextId ?? idGenerator("run");
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
    async markRunning(id) {
      const current = stored.get(id);
      if (current === undefined || (current.status !== "queued" && current.status !== "running")) {
        return false;
      }
      stored.set(id, { ...current, status: "running", startedAt: current.startedAt ?? new Date() });
      return true;
    },
    async markSucceeded(id) {
      const current = stored.get(id);
      if (current?.status !== "running") return false;
      stored.set(id, { ...current, status: "succeeded", finishedAt: new Date() });
      return true;
    },
    async markFailed(id, error) {
      const current = stored.get(id);
      if (current === undefined || (current.status !== "queued" && current.status !== "running")) {
        return false;
      }
      stored.set(id, { ...current, status: "failed", error: { ...error }, finishedAt: new Date() });
      return true;
    },
    async failAbandoned(startedBefore, error) {
      const closed: string[] = [];
      for (const [id, run] of stored) {
        if (run.status === "running" && run.startedAt !== null && run.startedAt < startedBefore) {
          stored.set(id, { ...run, status: "failed", error: { ...error }, finishedAt: new Date() });
          closed.push(id);
        }
      }
      return closed;
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

function copyData(data: BrokerData): BrokerData {
  return structuredCopy(data);
}
