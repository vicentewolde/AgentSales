import {
  type BrokerData,
  type BrokerRepository,
  type ImportReport,
  type ImportRunRepository,
  isAppError,
  type ListingRepository,
  type ListingStatus,
  type NewListing,
} from "@agentsales/core";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Suite de contrato de los puertos de la importación (F1-T04b): corre igual contra los dobles en
 * memoria (`@agentsales/core/testing`) y contra Drizzle sobre PGlite, así los dos tienen la misma
 * semántica por construcción. Cada caso usa sus propios slugs y refs: la base se comparte.
 */
export type ImportRepositories = {
  brokers: BrokerRepository;
  listings: ListingRepository;
  importRuns: ImportRunRepository;
  /** Cambio manual de estado (panel o CLI), para probar que `update` no lo pisa. */
  setListingStatus(id: string, status: ListingStatus): Promise<void>;
  /** Un id con el formato del adaptador que no existe (un uuid en Postgres). */
  missingId: string;
};

let sequence = 0;
const unique = (prefix: string) => `${prefix}-${++sequence}`;

export const brokerData = (slug: string, overrides: Partial<BrokerData> = {}): BrokerData => ({
  slug,
  name: "Persona Inventada",
  brandName: "Marca Inventada",
  primaryColor: "#112233",
  secondaryColor: "#445566",
  whatsapp: null,
  email: "contacto@example.cl",
  instagramHandle: null,
  website: null,
  tone: "Cercano",
  fixedHashtags: ["#uno", "#dos"],
  ...overrides,
});

export const newListing = (
  brokerId: string,
  externalRef: string,
  overrides: Partial<NewListing> = {},
): NewListing => ({
  brokerId,
  externalRef,
  category: "real_estate",
  source: "xlsx",
  operation: "sale",
  propertyType: "Departamento",
  region: "Metropolitana",
  comuna: "Ñuñoa",
  address: "Calle Inventada 123",
  unitNumber: null,
  showExactAddress: false,
  priceAmount: 5800,
  priceCurrency: "UF",
  highlights: null,
  internalNotes: null,
  attributes: { dormitorios: 3, amenities: ["Piscina"] },
  sourceHash: "hash-1",
  ...overrides,
});

const REPORT: ImportReport = {
  headers: { unknown: ["Vista al mar"], missing: [], duplicated: [] },
  broker: { slug: "marca", outcome: "created", issues: [], warnings: [] },
  rows: [
    {
      rowNumber: 2,
      externalRef: "P001",
      outcome: "created",
      listingId: null,
      errors: [],
      warnings: [],
    },
  ],
};

async function expectAppError(promise: Promise<unknown>, code: string, retriable = false) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(isAppError(error) && error.code, String(error)).toBe(code);
  expect(isAppError(error) && error.retriable).toBe(retriable);
}

export function importRepositoriesContract(name: string, make: () => Promise<ImportRepositories>) {
  describe(`${name} · BrokerRepository`, () => {
    let repos: ImportRepositories;
    beforeAll(async () => {
      repos = await make();
    });

    it("create y findBySlug; un slug desconocido es null", async () => {
      const slug = unique("corredor");
      const created = await repos.brokers.create(brokerData(slug));
      expect(created).toMatchObject({ ...brokerData(slug), logoMediaId: null, autoPublish: false });
      expect(await repos.brokers.findBySlug(slug)).toEqual(created);
      expect(await repos.brokers.findBySlug(unique("nadie"))).toBeNull();
    });

    it("create con un slug existente → BROKER_CONFLICT, reintentable", async () => {
      const slug = unique("corredor");
      await repos.brokers.create(brokerData(slug));
      await expectAppError(repos.brokers.create(brokerData(slug)), "BROKER_CONFLICT", true);
    });

    it("update cambia los datos de la hoja y conserva id, logo y auto_publish", async () => {
      const slug = unique("corredor");
      const created = await repos.brokers.create(brokerData(slug));
      const updated = await repos.brokers.update(
        created.id,
        brokerData(slug, { tone: "Formal", fixedHashtags: ["#tres"] }),
      );
      expect(updated).toEqual({ ...created, tone: "Formal", fixedHashtags: ["#tres"] });
      expect(await repos.brokers.findBySlug(slug)).toEqual(updated);
    });

    it("update de un id inexistente → BROKER_NOT_FOUND", async () => {
      await expectAppError(
        repos.brokers.update(repos.missingId, brokerData(unique("corredor"))),
        "BROKER_NOT_FOUND",
      );
    });
  });

  describe(`${name} · ListingRepository`, () => {
    let repos: ImportRepositories;
    let brokerId: string;
    let otherBrokerId: string;
    beforeAll(async () => {
      repos = await make();
      brokerId = (await repos.brokers.create(brokerData(unique("corredor")))).id;
      otherBrokerId = (await repos.brokers.create(brokerData(unique("corredor")))).id;
    });

    it("create nace en draft, y findByExternalRefs lo encuentra solo para su corredor", async () => {
      const ref = unique("P");
      const created = await repos.listings.create(newListing(brokerId, ref));
      expect(created).toEqual({
        id: expect.any(String),
        externalRef: ref,
        status: "draft",
        sourceHash: "hash-1",
      });
      expect(await repos.listings.findByExternalRefs(brokerId, [ref, unique("P")])).toEqual([
        created,
      ]);
      expect(await repos.listings.findByExternalRefs(otherBrokerId, [ref])).toEqual([]);
    });

    it("findByExternalRefs sin refs devuelve []", async () => {
      expect(await repos.listings.findByExternalRefs(brokerId, [])).toEqual([]);
    });

    it("el mismo external_ref en otro corredor no choca; en el mismo → LISTING_CONFLICT", async () => {
      const ref = unique("P");
      await repos.listings.create(newListing(brokerId, ref));
      await repos.listings.create(newListing(otherBrokerId, ref));
      await expectAppError(
        repos.listings.create(newListing(brokerId, ref)),
        "LISTING_CONFLICT",
        true,
      );
    });

    it("update cambia los datos y el hash, y no pisa un status puesto a mano", async () => {
      const ref = unique("P");
      const created = await repos.listings.create(newListing(brokerId, ref));
      await repos.setListingStatus(created.id, "paused");
      const {
        brokerId: _broker,
        category: _c,
        source: _s,
        ...data
      } = newListing(brokerId, ref, { priceAmount: 6100.5, sourceHash: "hash-2" });
      const updated = await repos.listings.update(created.id, data);
      expect(updated).toEqual({ ...created, status: "paused", sourceHash: "hash-2" });
    });

    it("update de un id inexistente → LISTING_NOT_FOUND", async () => {
      const { brokerId: _b, category: _c, source: _s, ...data } = newListing(brokerId, unique("P"));
      await expectAppError(repos.listings.update(repos.missingId, data), "LISTING_NOT_FOUND");
    });
  });

  describe(`${name} · ImportRunRepository`, () => {
    let repos: ImportRepositories;
    const input = { xlsxPath: "/tmp/agentsales/propiedades.xlsx", mediaDir: null, broker: null };
    beforeAll(async () => {
      repos = await make();
    });

    it("create nace en queued, sin reporte ni contadores, y guarda el input", async () => {
      const run = await repos.importRuns.create({
        source: "xlsx",
        fileName: "propiedades.xlsx",
        dryRun: true,
        input,
      });
      expect(run).toMatchObject({
        status: "queued",
        dryRun: true,
        source: "xlsx",
        fileName: "propiedades.xlsx",
        input,
        brokerId: null,
        report: null,
        error: null,
        rowsTotal: 0,
        startedAt: null,
        finishedAt: null,
      });
      expect(await repos.importRuns.get(run.id)).toEqual(run);
    });

    it("get de un id inexistente es null", async () => {
      expect(await repos.importRuns.get(repos.missingId)).toBeNull();
    });

    it("recordListingsResult guarda corredor, contadores y reporte, sin cambiar el estado", async () => {
      const brokerId = (await repos.brokers.create(brokerData(unique("corredor")))).id;
      const run = await repos.importRuns.create({
        source: "xlsx",
        fileName: "propiedades.xlsx",
        dryRun: false,
        input,
      });
      const counts = {
        rowsTotal: 3,
        rowsCreated: 1,
        rowsUpdated: 1,
        rowsSkipped: 0,
        rowsFailed: 1,
      };
      await repos.importRuns.recordListingsResult(run.id, { brokerId, counts, report: REPORT });
      expect(await repos.importRuns.get(run.id)).toEqual({
        ...run,
        brokerId,
        ...counts,
        report: REPORT,
      });
    });

    it("recordListingsResult de un id inexistente → IMPORT_RUN_NOT_FOUND", async () => {
      await expectAppError(
        repos.importRuns.recordListingsResult(repos.missingId, {
          brokerId: null,
          counts: { rowsTotal: 0, rowsCreated: 0, rowsUpdated: 0, rowsSkipped: 0, rowsFailed: 0 },
          report: REPORT,
        }),
        "IMPORT_RUN_NOT_FOUND",
      );
    });
  });
}
