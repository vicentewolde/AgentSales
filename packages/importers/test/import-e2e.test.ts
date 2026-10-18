import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ImportUploadMediaRequest,
  requestImportUpload,
  runImport,
  startImport,
} from "@agentsales/core";
import {
  createInMemoryBrokerRepository,
  createInMemoryFieldDefinitionRepository,
  createInMemoryImportRunRepository,
  createInMemoryJobQueue,
  createInMemoryListingRepository,
  createInMemoryMediaRepository,
  createInMemoryMediaStorage,
} from "@agentsales/core/testing";
import { REAL_ESTATE_FIELD_DEFINITIONS } from "@agentsales/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStaging } from "../src/staging.js";
import { SAMPLES, sha256 } from "./media-fixtures.js";
import { buildWorkbook, syntheticRow } from "./workbook.js";
import { buildZip } from "./zip-builder.js";

// Una carga de punta a punta con el doble de R2 (spec F8 §4.4, F8-T05): pedir la subida, subir con
// las URLs firmadas, empezar, y el job la corre bajando los archivos con el staging del worker.

const RUN_ID = "7f1c2a4e-9b3d-4f6a-8c2e-1d5b9a7e3f10";
let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "agentsales-e2e-"));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function setup() {
  // El mismo bucket guarda las subidas y los medios del aviso, como en producción.
  const storage = createInMemoryMediaStorage({ sha256 });
  const media = createInMemoryMediaRepository();
  const brokers = createInMemoryBrokerRepository([], { media });
  await brokers.create({
    slug: "marca",
    name: "Persona Inventada",
    brandName: "Marca Inventada",
    primaryColor: "#112233",
    secondaryColor: "#112233",
    whatsapp: null,
    email: null,
    instagramHandle: null,
    website: null,
    tone: null,
    fixedHashtags: [],
  });
  const listings = createInMemoryListingRepository();
  const importRuns = createInMemoryImportRunRepository({ nextId: () => RUN_ID });
  const queue = createInMemoryJobQueue();
  const staging = createStaging({
    root: join(work, "tmp", "imports"),
    storage,
    maxVideoBytes: 1024 * 1024,
  });
  const deps = {
    brokers,
    listings,
    importRuns,
    fieldDefinitions: createInMemoryFieldDefinitionRepository(
      REAL_ESTATE_FIELD_DEFINITIONS.map((def, index) => ({ ...def, id: `def-${index}` })),
    ),
    media,
    storage,
    sha256: async (text: string) => sha256(new TextEncoder().encode(text)),
    readSheet: staging.readSheet,
    openMedia: staging.openMedia,
    discardInput: staging.discard,
  };

  /** El panel o la CLI: pide la carga, sube cada archivo con su URL y la empieza. */
  async function upload(
    files: Map<string, Uint8Array>,
    mediaRequest: ImportUploadMediaRequest | null,
  ) {
    const xlsx = await buildWorkbook({ listings: { rows: [syntheticRow()] } });
    files.set("propiedades.xlsx", xlsx);
    const { run, uploads } = await requestImportUpload(
      { importRuns, storage, newId: () => RUN_ID, maxFileBytes: 512 * 1024 * 1024 },
      {
        broker: "marca",
        brokerId: null,
        dryRun: false,
        xlsx: { name: "propiedades.xlsx", size: xlsx.byteLength, sha256: sha256(xlsx) },
        media: mediaRequest,
      },
    );
    for (const target of uploads) {
      const body = files.get(target.name);
      if (body === undefined) throw new Error(`falta ${target.name}`);
      await storage.receiveUpload(target.url, target.headers, body);
    }
    return startImport({ importRuns, storage, queue }, { importRunId: run.id });
  }

  return { deps, storage, listings, media, queue, upload, root: join(work, "tmp", "imports") };
}

describe("una carga subida a R2, de punta a punta", () => {
  it.each(["zip", "folder"] as const)(
    "con medios en %s: crea el aviso, sube la foto y borra lo subido",
    async (kind) => {
      const s = await setup();
      const photo = SAMPLES.jpeg("a", 128);
      const files = new Map<string, Uint8Array>();
      let mediaRequest: ImportUploadMediaRequest;
      if (kind === "zip") {
        const zip = new Uint8Array(buildZip([{ name: "P001/01_living.jpg", data: photo }]));
        files.set("medios.zip", zip);
        mediaRequest = { kind: "zip", name: "medios.zip", size: zip.byteLength };
      } else {
        files.set("P001/01_living.jpg", photo);
        mediaRequest = {
          kind: "folder",
          name: "medios",
          files: [{ path: "P001/01_living.jpg", size: photo.byteLength, sha256: sha256(photo) }],
        };
      }

      const started = await s.upload(files, mediaRequest);
      expect(started.status).toBe("queued");
      expect(s.queue.jobs).toHaveLength(1);

      expect(await runImport(s.deps, { importRunId: RUN_ID, isLastAttempt: false })).toEqual({
        outcome: "succeeded",
      });

      const [listing] = s.listings.all();
      expect(listing).toMatchObject({ externalRef: "P001", status: "ready" });
      expect(s.media.all()).toHaveLength(1);
      expect(await s.deps.importRuns.get(RUN_ID)).toMatchObject({
        status: "succeeded",
        report: { media: { filesUploaded: 1 } },
      });
      // Lo subido para la carga se borró de R2 y del disco del worker; la foto del aviso quedó.
      expect(await s.storage.list(`imports/${RUN_ID}/`)).toEqual([]);
      expect(await s.storage.list("brokers/")).toHaveLength(1);
      expect(await readdir(s.root).catch(() => [])).toEqual([]);
    },
  );

  it("un archivo que no llegó a R2 impide empezar: IMPORT_UPLOAD_INCOMPLETE", async () => {
    const s = await setup();
    const photo = SAMPLES.jpeg("a", 128);
    const xlsx = await buildWorkbook({ listings: { rows: [syntheticRow()] } });
    const { run, uploads } = await requestImportUpload(
      {
        importRuns: s.deps.importRuns,
        storage: s.storage,
        newId: () => RUN_ID,
        maxFileBytes: 1024 ** 3,
      },
      {
        broker: "marca",
        brokerId: null,
        dryRun: false,
        xlsx: { name: "propiedades.xlsx", size: xlsx.byteLength, sha256: sha256(xlsx) },
        media: {
          kind: "folder",
          name: "medios",
          files: [{ path: "P001/01_living.jpg", size: photo.byteLength, sha256: sha256(photo) }],
        },
      },
    );
    const [sheet] = uploads;
    if (sheet === undefined) throw new Error("sin URL de la planilla");
    await s.storage.receiveUpload(sheet.url, sheet.headers, xlsx);

    await expect(
      startImport(
        { importRuns: s.deps.importRuns, storage: s.storage, queue: s.queue },
        { importRunId: run.id },
      ),
    ).rejects.toMatchObject({
      code: "IMPORT_UPLOAD_INCOMPLETE",
      details: { missing: ["P001/01_living.jpg"] },
    });
  });
});
