import {
  type BrokerData,
  type BrokerRepository,
  type ImportReport,
  type ImportRunRepository,
  isAppError,
  type ListingRepository,
  type ListingStatus,
  type MediaRepository,
  type NewListing,
  type NewMedia,
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
  media: MediaRepository;
  /** Cambio manual de estado (panel o CLI), para probar que `update` no lo pisa. */
  setListingStatus(id: string, status: ListingStatus): Promise<void>;
  /** Cambio de `auto_publish` fuera de la hoja Corredor, para probar que `update` no lo pisa. */
  setBrokerAutoPublish(id: string, autoPublish: boolean): Promise<void>;
  /** Un id con el formato del adaptador que no existe (un uuid en Postgres). */
  missingId: string;
  /** Un id nuevo con el formato del adaptador (para `create` con id). */
  newId: () => string;
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

/** Un medio original sintético; sin `listingId`, es un logo del corredor. */
export const newMedia = (
  brokerId: string,
  listingId: string | null,
  checksum: string,
  overrides: Partial<NewMedia> = {},
): NewMedia => ({
  listingId,
  brokerId,
  kind: "image",
  storagePath:
    listingId === null
      ? `brokers/${brokerId}/brand/${checksum}.png`
      : `brokers/${brokerId}/listings/${listingId}/original/${checksum}.jpg`,
  mime: "image/jpeg",
  bytes: 1234,
  checksum,
  sortOrder: 0,
  isCover: false,
  ...overrides,
});

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

    it("update cambia los datos de la hoja y conserva id y auto_publish", async () => {
      const slug = unique("corredor");
      const original = await repos.brokers.create(brokerData(slug));
      // Fuera del valor por defecto: si `update` escribiera `auto_publish`, se notaría.
      await repos.setBrokerAutoPublish(original.id, true);
      const created = { ...original, autoPublish: true };
      const updated = await repos.brokers.update(
        created.id,
        brokerData(slug, { tone: "Formal", fixedHashtags: ["#tres"] }),
      );
      expect(updated).toEqual({ ...created, tone: "Formal", fixedHashtags: ["#tres"] });
      expect(await repos.brokers.findBySlug(slug)).toEqual(updated);
    });

    it("list devuelve los corredores por nombre de marca, sin distinguir mayúsculas", async () => {
      const c = await repos.brokers.create(
        brokerData(unique("lista-c"), { brandName: "ZZ marca c" }),
      );
      const b = await repos.brokers.create(
        brokerData(unique("lista-b"), { brandName: "ZZ Marca B" }),
      );
      const a = await repos.brokers.create(
        brokerData(unique("lista-a"), { brandName: "zz marca a" }),
      );
      const listed = (await repos.brokers.list()).filter((broker) =>
        broker.brandName.toLowerCase().startsWith("zz"),
      );
      expect(listed.map((broker) => broker.id)).toEqual([a.id, b.id, c.id]);
      expect(listed[0]).toEqual(a);
    });

    it("update de un id inexistente → BROKER_NOT_FOUND", async () => {
      await expectAppError(
        repos.brokers.update(repos.missingId, brokerData(unique("corredor"))),
        "BROKER_NOT_FOUND",
      );
    });

    it("setLogo fija el logo, y update de la hoja no lo pisa", async () => {
      const slug = unique("corredor");
      const created = await repos.brokers.create(brokerData(slug));
      const mediaId = (await repos.media.create(newMedia(created.id, null, unique("logo")))).id;
      await repos.brokers.setLogo(created.id, mediaId);
      expect(await repos.brokers.findBySlug(slug)).toEqual({ ...created, logoMediaId: mediaId });

      const updated = await repos.brokers.update(created.id, brokerData(slug, { tone: "Formal" }));
      expect(updated.logoMediaId).toBe(mediaId);
    });

    it("setLogo de un id inexistente → BROKER_NOT_FOUND", async () => {
      const brokerId = (await repos.brokers.create(brokerData(unique("corredor")))).id;
      const mediaId = (await repos.media.create(newMedia(brokerId, null, unique("logo")))).id;
      await expectAppError(repos.brokers.setLogo(repos.missingId, mediaId), "BROKER_NOT_FOUND");
    });

    it("setLogo con un medio inexistente, de otro corredor o de un aviso → MEDIA_NOT_FOUND", async () => {
      const slug = unique("corredor");
      const brokerId = (await repos.brokers.create(brokerData(slug))).id;
      const otherId = (await repos.brokers.create(brokerData(unique("corredor")))).id;
      const ajeno = (await repos.media.create(newMedia(otherId, null, unique("logo")))).id;
      const listingId = (await repos.listings.create(newListing(brokerId, unique("P")))).id;
      const deAviso = (await repos.media.create(newMedia(brokerId, listingId, unique("foto")))).id;

      for (const mediaId of [repos.missingId, ajeno, deAviso]) {
        await expectAppError(repos.brokers.setLogo(brokerId, mediaId), "MEDIA_NOT_FOUND");
      }
      expect((await repos.brokers.findBySlug(slug))?.logoMediaId).toBeNull();
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

    it("get devuelve la entidad completa; un id inexistente es null", async () => {
      const ref = unique("P");
      const created = await repos.listings.create(
        newListing(brokerId, ref, { priceAmount: 6100.5 }),
      );
      const listing = await repos.listings.get(created.id);
      expect(listing).toMatchObject({
        id: created.id,
        brokerId,
        externalRef: ref,
        status: "draft",
        closeReason: null,
        priceAmount: 6100.5,
        attributes: { dormitorios: 3, amenities: ["Piscina"] },
        source: "xlsx",
      });
      expect(listing?.createdAt).toBeInstanceOf(Date);
      expect(listing).not.toHaveProperty("sourceHash");
      expect(await repos.listings.get(repos.missingId)).toBeNull();
    });

    it("list filtra por estado, operación y comuna, del más reciente al más antiguo", async () => {
      const other = (await repos.brokers.create(brokerData(unique("filtros")))).id;
      const comuna = unique("Comuna");
      const first = await repos.listings.create(newListing(other, unique("P"), { comuna }));
      const second = await repos.listings.create(
        newListing(other, unique("P"), { comuna, operation: "rent" }),
      );
      await repos.listings.create(newListing(other, unique("P"), { comuna: unique("Otra") }));
      await repos.listings.promoteToReady(first.id);

      expect((await repos.listings.list({ comuna })).map((listing) => listing.id)).toEqual([
        first.id,
        second.id,
      ]);
      expect((await repos.listings.list({ comuna, status: "ready" })).map((l) => l.id)).toEqual([
        first.id,
      ]);
      expect((await repos.listings.list({ comuna, operation: "rent" })).map((l) => l.id)).toEqual([
        second.id,
      ]);
    });

    it("changeStatus es condicional: solo desde el estado esperado", async () => {
      const created = await repos.listings.create(newListing(brokerId, unique("P")));
      expect(await repos.listings.changeStatus(created.id, "ready", "paused")).toBe(false);
      expect(await repos.listings.changeStatus(created.id, "draft", "archived")).toBe(true);
      expect((await repos.listings.get(created.id))?.status).toBe("archived");
      expect(await repos.listings.changeStatus(repos.missingId, "draft", "ready")).toBe(false);
    });

    it("promoteToReady pasa de draft a ready una sola vez", async () => {
      const ref = unique("P");
      const created = await repos.listings.create(newListing(brokerId, ref));
      expect(await repos.listings.promoteToReady(created.id)).toBe(true);
      expect(await repos.listings.promoteToReady(created.id)).toBe(false);
      const [found] = await repos.listings.findByExternalRefs(brokerId, [ref]);
      expect(found?.status).toBe("ready");
    });

    it.each(["paused", "archived", "active", "closed"] as const)(
      "promoteToReady no toca un aviso en %s",
      async (status) => {
        const ref = unique("P");
        const created = await repos.listings.create(newListing(brokerId, ref));
        await repos.setListingStatus(created.id, status);
        expect(await repos.listings.promoteToReady(created.id)).toBe(false);
        const [found] = await repos.listings.findByExternalRefs(brokerId, [ref]);
        expect(found?.status).toBe(status);
      },
    );

    it("promoteToReady de un id inexistente devuelve false", async () => {
      expect(await repos.listings.promoteToReady(repos.missingId)).toBe(false);
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

    it("create con un id dado lo usa; list devuelve los más recientes primero, con tope", async () => {
      const id = repos.newId();
      const withId = await repos.importRuns.create({
        id,
        source: "xlsx",
        fileName: "con-id.xlsx",
        dryRun: false,
        input,
      });
      expect(withId.id).toBe(id);
      // `created_at` de PGlite puede empatar al milisegundo: se separan para que el orden no
      // dependa del desempate (un uuid al azar).
      await new Promise((resolve) => setTimeout(resolve, 5));
      const newer = await repos.importRuns.create({
        source: "xlsx",
        fileName: "despues.xlsx",
        dryRun: false,
        input,
      });

      const duplicate = await repos.importRuns
        .create({ id, source: "xlsx", fileName: "otra.xlsx", dryRun: false, input })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(isAppError(duplicate) && [duplicate.code, duplicate.retriable]).toEqual([
        "IMPORT_RUN_CONFLICT",
        false,
      ]);

      const recent = await repos.importRuns.list(2);
      expect(recent.map((run) => run.id)).toEqual([newer.id, withId.id]);
      expect(await repos.importRuns.list(1)).toHaveLength(1);
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

    const newRun = () =>
      repos.importRuns.create({ source: "xlsx", fileName: "p.xlsx", dryRun: false, input });

    it("markRunning toma un run en cola o en curso, y fija started_at solo la primera vez", async () => {
      const run = await newRun();
      expect(await repos.importRuns.markRunning(run.id)).toBe(true);
      const first = await repos.importRuns.get(run.id);
      expect(first).toMatchObject({ status: "running", finishedAt: null });
      expect(first?.startedAt).toBeInstanceOf(Date);

      // Un reintento del job vuelve a tomarlo, sin mover started_at.
      expect(await repos.importRuns.markRunning(run.id)).toBe(true);
      expect((await repos.importRuns.get(run.id))?.startedAt).toEqual(first?.startedAt);
    });

    it("markSucceeded solo desde running, con finished_at", async () => {
      const run = await newRun();
      expect(await repos.importRuns.markSucceeded(run.id)).toBe(false);
      await repos.importRuns.markRunning(run.id);

      expect(await repos.importRuns.markSucceeded(run.id)).toBe(true);
      const done = await repos.importRuns.get(run.id);
      expect(done).toMatchObject({ status: "succeeded", error: null });
      expect(done?.finishedAt).toBeInstanceOf(Date);
    });

    it("markFailed desde queued o running, con error y finished_at", async () => {
      const queued = await newRun();
      const running = await newRun();
      await repos.importRuns.markRunning(running.id);
      const error = { code: "STORAGE_UNAVAILABLE", message: "R2 no respondió" };

      for (const run of [queued, running]) {
        expect(await repos.importRuns.markFailed(run.id, error)).toBe(true);
        const failed = await repos.importRuns.get(run.id);
        expect(failed).toMatchObject({ status: "failed", error });
        expect(failed?.finishedAt).toBeInstanceOf(Date);
      }
    });

    it("un run terminal no cambia: el primer estado terminal gana", async () => {
      const succeeded = await newRun();
      await repos.importRuns.markRunning(succeeded.id);
      await repos.importRuns.markSucceeded(succeeded.id);
      const failed = await newRun();
      await repos.importRuns.markFailed(failed.id, { code: "X", message: "primero" });

      for (const run of [succeeded, failed]) {
        const before = await repos.importRuns.get(run.id);
        expect(await repos.importRuns.markRunning(run.id)).toBe(false);
        expect(await repos.importRuns.markSucceeded(run.id)).toBe(false);
        expect(await repos.importRuns.markFailed(run.id, { code: "Y", message: "otro" })).toBe(
          false,
        );
        expect(await repos.importRuns.get(run.id)).toEqual(before);
      }
    });

    it("failAbandoned cierra los running viejos; deja los recientes, los queued y los terminados", async () => {
      const viejo = await newRun();
      await repos.importRuns.markRunning(viejo.id);
      const enCola = await newRun();
      const terminado = await newRun();
      await repos.importRuns.markRunning(terminado.id);
      await repos.importRuns.markSucceeded(terminado.id);
      const error = { code: "IMPORT_ABANDONED", message: "La carga quedó a medias" };

      // Un corte en el futuro: todo lo que está running "empezó antes".
      const closed = await repos.importRuns.failAbandoned(new Date(Date.now() + 60_000), error);

      expect(closed).toContain(viejo.id);
      expect(closed).not.toContain(enCola.id);
      expect(closed).not.toContain(terminado.id);
      expect(await repos.importRuns.get(viejo.id)).toMatchObject({ status: "failed", error });
      expect((await repos.importRuns.get(enCola.id))?.status).toBe("queued");
      expect((await repos.importRuns.get(terminado.id))?.status).toBe("succeeded");

      const reciente = await newRun();
      await repos.importRuns.markRunning(reciente.id);
      expect(
        await repos.importRuns.failAbandoned(new Date(Date.now() - 60_000), error),
      ).not.toContain(reciente.id);
      expect((await repos.importRuns.get(reciente.id))?.status).toBe("running");
    });

    it("los cambios de estado de un id inexistente devuelven false", async () => {
      expect(await repos.importRuns.markRunning(repos.missingId)).toBe(false);
      expect(await repos.importRuns.markSucceeded(repos.missingId)).toBe(false);
      expect(await repos.importRuns.markFailed(repos.missingId, { code: "X", message: "x" })).toBe(
        false,
      );
    });

    it("recordMediaResult reemplaza el reporte y no toca contadores ni estado", async () => {
      const brokerId = (await repos.brokers.create(brokerData(unique("corredor")))).id;
      const run = await repos.importRuns.create({
        source: "xlsx",
        fileName: "propiedades.xlsx",
        dryRun: false,
        input,
      });
      const counts = {
        rowsTotal: 1,
        rowsCreated: 1,
        rowsUpdated: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
      };
      await repos.importRuns.recordListingsResult(run.id, { brokerId, counts, report: REPORT });
      const withMedia: ImportReport = {
        ...REPORT,
        rows: REPORT.rows.map((row) => ({ ...row, warnings: ["notas.txt: tipo no admitido"] })),
        media: { filesUploaded: 3, filesExisting: 1, filesSkipped: 1, filesFailed: 0 },
      };

      await repos.importRuns.recordMediaResult(run.id, withMedia);

      expect(await repos.importRuns.get(run.id)).toEqual({
        ...run,
        brokerId,
        ...counts,
        report: withMedia,
      });
    });

    it("recordMediaResult de un id inexistente → IMPORT_RUN_NOT_FOUND", async () => {
      await expectAppError(
        repos.importRuns.recordMediaResult(repos.missingId, REPORT),
        "IMPORT_RUN_NOT_FOUND",
      );
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

  describe(`${name} · MediaRepository`, () => {
    let repos: ImportRepositories;
    let brokerId: string;
    let listingId: string;
    beforeAll(async () => {
      repos = await make();
      brokerId = (await repos.brokers.create(brokerData(unique("corredor")))).id;
      listingId = (await repos.listings.create(newListing(brokerId, unique("P")))).id;
    });

    /** Un aviso nuevo con sus medios, en el orden dado por `sortOrder`. */
    async function listingWith(...checksums: string[]) {
      const id = (await repos.listings.create(newListing(brokerId, unique("P")))).id;
      const created = [];
      for (const [index, checksum] of checksums.entries()) {
        created.push(
          await repos.media.create(newMedia(brokerId, id, unique(checksum), { sortOrder: index })),
        );
      }
      return { id, media: created };
    }

    it("create devuelve el registro; listOriginals ordena por sortOrder", async () => {
      const id = (await repos.listings.create(newListing(brokerId, unique("P")))).id;
      const second = await repos.media.create(
        newMedia(brokerId, id, unique("b"), { sortOrder: 1, kind: "video", mime: "video/mp4" }),
      );
      const first = await repos.media.create(newMedia(brokerId, id, unique("a"), { sortOrder: 0 }));
      expect(second).toMatchObject({ listingId: id, brokerId, kind: "video", sortOrder: 1 });

      expect(await repos.media.listOriginals(id)).toEqual([first, second]);
      expect(await repos.media.listOriginals(listingId)).toEqual([]);
    });

    it("findByStoragePath encuentra un logo (sin aviso); una ruta desconocida es null", async () => {
      const logo = await repos.media.create(newMedia(brokerId, null, unique("logo")));
      expect(await repos.media.findByStoragePath(logo.storagePath)).toEqual(logo);
      expect(await repos.media.findByStoragePath(`${logo.storagePath}.x`)).toBeNull();
    });

    it("el mismo archivo dos veces en un aviso, o la misma ruta → MEDIA_CONFLICT, reintentable", async () => {
      const checksum = unique("dup");
      const original = await repos.media.create(newMedia(brokerId, listingId, checksum));

      await expectAppError(
        repos.media.create(newMedia(brokerId, listingId, checksum, { storagePath: unique("x") })),
        "MEDIA_CONFLICT",
        true,
      );
      await expectAppError(
        repos.media.create(
          newMedia(brokerId, listingId, unique("otro"), { storagePath: original.storagePath }),
        ),
        "MEDIA_CONFLICT",
        true,
      );
    });

    it("el mismo archivo en otro aviso, o dos logos con el mismo archivo y otra ruta, sí valen", async () => {
      const checksum = unique("compartido");
      const other = (await repos.listings.create(newListing(brokerId, unique("P")))).id;
      await repos.media.create(newMedia(brokerId, listingId, checksum));
      await repos.media.create(newMedia(brokerId, other, checksum));
      await repos.media.create(newMedia(brokerId, null, checksum));
      await repos.media.create(
        newMedia(brokerId, null, checksum, { storagePath: `${unique("logo")}.png` }),
      );
    });

    it("listCovers trae solo las portadas de esos avisos", async () => {
      const { id, media } = await listingWith("a", "b");
      const other = await listingWith("c");
      await repos.media.arrange(id, [{ id: media[1]?.id ?? "", sortOrder: 0, isCover: true }]);
      await repos.media.arrange(other.id, [
        { id: other.media[0]?.id ?? "", sortOrder: 0, isCover: true },
      ]);

      const covers = await repos.media.listCovers([id]);

      expect(covers.map((cover) => cover.id)).toEqual([media[1]?.id]);
      expect(await repos.media.listCovers([])).toEqual([]);
    });

    it("arrange fija orden y portada", async () => {
      const { id, media } = await listingWith("a", "b", "c");
      const [a, b, c] = media.map((item) => item.id) as [string, string, string];

      await repos.media.arrange(id, [
        { id: c, sortOrder: 0, isCover: true },
        { id: a, sortOrder: 1, isCover: false },
        { id: b, sortOrder: 2, isCover: false },
      ]);

      expect(
        (await repos.media.listOriginals(id)).map(({ id: mediaId, sortOrder, isCover }) => [
          mediaId,
          sortOrder,
          isCover,
        ]),
      ).toEqual([
        [c, 0, true],
        [a, 1, false],
        [b, 2, false],
      ]);
    });

    it("una sola portada: la nueva desmarca la anterior aunque no venga en items", async () => {
      const { id, media } = await listingWith("a", "b");
      const [a, b] = media.map((item) => item.id) as [string, string];
      await repos.media.arrange(id, [{ id: a, sortOrder: 0, isCover: true }]);

      await repos.media.arrange(id, [{ id: b, sortOrder: 1, isCover: true }]);

      expect((await repos.media.listOriginals(id)).filter((item) => item.isCover)).toEqual([
        expect.objectContaining({ id: b }),
      ]);
    });

    it("arrange con un medio de otro aviso → MEDIA_NOT_FOUND, sin cambiar nada", async () => {
      const { id, media } = await listingWith("a");
      const other = await listingWith("b");
      const before = await repos.media.listOriginals(id);

      await expectAppError(
        repos.media.arrange(id, [
          { id: media[0]?.id ?? "", sortOrder: 5, isCover: true },
          { id: other.media[0]?.id ?? "", sortOrder: 6, isCover: false },
        ]),
        "MEDIA_NOT_FOUND",
      );
      expect(await repos.media.listOriginals(id)).toEqual(before);
    });

    it.each([
      [
        "ids repetidos",
        (a: string) => [
          { id: a, sortOrder: 0, isCover: false },
          { id: a, sortOrder: 1, isCover: false },
        ],
      ],
      [
        "dos portadas",
        (a: string, b: string) => [
          { id: a, sortOrder: 0, isCover: true },
          { id: b, sortOrder: 1, isCover: true },
        ],
      ],
      ["un orden negativo", (a: string) => [{ id: a, sortOrder: -1, isCover: false }]],
      ["un orden decimal", (a: string) => [{ id: a, sortOrder: 1.5, isCover: false }]],
      ["un orden fuera de int4", (a: string) => [{ id: a, sortOrder: 2 ** 31, isCover: false }]],
      ["un orden NaN", (a: string) => [{ id: a, sortOrder: Number.NaN, isCover: false }]],
    ])("arrange con %s → MEDIA_ARRANGE_INVALID, sin cambiar nada", async (_, itemsOf) => {
      const { id, media } = await listingWith("a", "b");
      const before = await repos.media.listOriginals(id);

      await expectAppError(
        repos.media.arrange(id, itemsOf(media[0]?.id ?? "", media[1]?.id ?? "")),
        "MEDIA_ARRANGE_INVALID",
      );
      expect(await repos.media.listOriginals(id)).toEqual(before);
    });
  });
}
