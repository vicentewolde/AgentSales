import { randomUUID } from "node:crypto";
import { type AppDeps, createApp, localAccess } from "@agentsales/api";
import { testDeps } from "@agentsales/api/testing";
import type {
  AppError,
  BrokerData,
  ContentRunReport,
  ContentRunStage,
  ImportReport,
  NewContent,
  NewListing,
  PublishMode,
} from "@agentsales/core";
import {
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryImportRunRepository,
  createInMemoryJobQueue,
  createInMemoryListingLock,
  createInMemoryListingRepository,
  createInMemoryMediaRepository,
  createInMemoryPlatformAccountRepository,
  createInMemoryPublicationRepository,
  createPublicationScenario,
} from "@agentsales/core/testing";
import { createApiClient } from "../src/api-client.js";
import { createColors } from "../src/colors.js";
import type { Io } from "../src/output.js";

export const PORT = 8787;

export type HarnessOptions = {
  deps?: Partial<AppDeps>;
  /** Se llama antes de cada petición: lanzar simula una falla de red. */
  beforeRequest?: (url: string, method: string) => void;
};

/**
 * La API real en proceso (`createApp` con repositorios en memoria) detrás del cliente de la CLI,
 * sin red: `fetch` es `app.request` (spec F1-T12). Guarda lo que la CLI imprime.
 */
export function harness(options: HarnessOptions = {}) {
  const importRuns = createInMemoryImportRunRepository({ nextId: randomUUID });
  const listings = createInMemoryListingRepository({ nextId: randomUUID });
  const brokers = createInMemoryBrokerRepository();
  const media = createInMemoryMediaRepository();
  const queue = createInMemoryJobQueue();
  const content = createInMemoryContentRepositories({ nextId: randomUUID });
  // El candado con las publicaciones a mano, para armar casos como una publicación pendiente. La
  // API y el candado comparten publicaciones y cuentas.
  const publications = createInMemoryPublicationRepository();
  const platformAccounts = createInMemoryPlatformAccountRepository({ nextId: randomUUID });
  const lock = createInMemoryListingLock({
    brokers,
    listings,
    media,
    contentRuns: content.contentRuns,
    contents: content.contents,
    publications,
    platformAccounts,
  });
  const app = createApp(
    testDeps({
      access: localAccess(PORT, 5173),
      importRuns,
      listings,
      brokers,
      media,
      queue,
      contentRuns: content.contentRuns,
      contents: content.contents,
      publications,
      platformAccounts,
      lock,
      ...options.deps,
    }),
  );
  const requests: string[] = [];
  const client = createApiClient(PORT, {
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      requests.push(`${method} ${new URL(url).pathname}`);
      options.beforeRequest?.(url, method);
      return app.request(url, init);
    },
  });
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    print: (text) => out.push(text),
    printError: (text) => err.push(text),
    colors: createColors(false),
  };
  return {
    client,
    io,
    out,
    err,
    text: () => out.join("\n"),
    errors: () => err.join("\n"),
    requests,
    importRuns,
    listings,
    brokers,
    media,
    queue,
    contentRuns: content.contentRuns,
    contents: content.contents,
    publications,
    platformAccounts,
  };
}

/**
 * Un aviso preparado con la cuenta de Instagram conectada (el escenario de publicación de core, con
 * ids uuid) y la CLI sobre la API real en proceso. `h.*` son los repositorios del arnés; los del
 * escenario están en `t`.
 */
export async function publicationHarness(
  options: {
    approve?: boolean;
    account?: boolean;
    publishMode?: PublishMode;
    queueFails?: () => AppError | undefined;
  } = {},
) {
  const t = await createPublicationScenario({
    nextId: randomUUID,
    approve: options.approve ?? true,
    account: options.account ?? true,
    ...(options.queueFails === undefined ? {} : { queueFails: options.queueFails }),
  });
  const h = harness({
    deps: {
      listings: t.listings,
      brokers: t.brokers,
      media: t.media,
      fieldDefinitions: t.fieldDefinitions,
      storage: t.storage,
      contents: t.contents,
      contentRuns: t.contentRuns,
      platformAccounts: t.platformAccounts,
      publications: t.publications,
      lock: t.deps.lock,
      queue: t.deps.queue,
      publishMode: options.publishMode ?? "dry-run",
    },
  });
  return { h, t };
}

/** Reloj falso: `sleep` avanza el tiempo y avisa a `onTick` (que hace de worker). */
export function fakeClock(onTick: (elapsedMs: number) => Promise<void> | void = () => {}) {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
      await onTick(now);
    },
  };
}

/** Corredor sintético (datos inventados). */
export const brokerData = (slug: string): BrokerData => ({
  slug,
  name: "Persona Inventada",
  brandName: `Marca ${slug}`,
  primaryColor: "#112233",
  secondaryColor: "#112233",
  whatsapp: null,
  email: null,
  instagramHandle: null,
  website: null,
  tone: null,
  fixedHashtags: [],
});

/** Aviso sintético (datos inventados). */
export const newListing = (
  brokerId: string,
  externalRef: string,
  extra: Partial<NewListing> = {},
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
  attributes: { dormitorios: 3 },
  sourceHash: "hash",
  ...extra,
});

/** Reporte de una carga con dos avisos creados y uno con errores (datos inventados). */
export const sampleReport = (): ImportReport => ({
  headers: { unknown: ["vista_al_mar"], missing: [], duplicated: [] },
  broker: { slug: "marca", outcome: "created", issues: [], warnings: [] },
  rows: [
    {
      rowNumber: 3,
      externalRef: "P-001",
      outcome: "created",
      listingId: randomUUID(),
      errors: [],
      warnings: [],
    },
    {
      rowNumber: 4,
      externalRef: "P-002",
      outcome: "created",
      listingId: randomUUID(),
      errors: [],
      warnings: ["Sin fotos: queda en borrador"],
    },
    {
      rowNumber: 5,
      externalRef: "P-003",
      outcome: "failed",
      listingId: null,
      errors: [
        {
          column: "precio",
          key: "precio",
          code: "FIELD_REQUIRED",
          message: "Falta el precio",
        },
      ],
      warnings: [],
    },
  ],
  media: { filesUploaded: 3, filesExisting: 0, filesSkipped: 1, filesFailed: 0 },
});

/** Hace de worker: lleva la carga a `running` y después la termina con `report`. */
export function simulateWorker(
  h: ReturnType<typeof harness>,
  report: ImportReport = sampleReport(),
) {
  const runId = async () => {
    const [run] = await h.importRuns.list(1);
    if (run === undefined) throw new Error("no hay cargas");
    return run.id;
  };
  return {
    start: async () => {
      await h.importRuns.markRunning(await runId());
    },
    finish: async () => {
      const id = await runId();
      const created = report.rows.filter((row) => row.outcome === "created").length;
      const failed = report.rows.filter((row) => row.outcome === "failed").length;
      await h.importRuns.recordListingsResult(id, {
        brokerId: null,
        counts: {
          rowsTotal: report.rows.length,
          rowsCreated: created,
          rowsUpdated: 0,
          rowsSkipped: 0,
          rowsFailed: failed,
        },
        report,
      });
      await h.importRuns.markSucceeded(id);
    },
    fail: async (code: string, message: string) => {
      await h.importRuns.markFailed(await runId(), { code, message });
    },
  };
}

/** Una propiedad lista (con una foto) del corredor `marca`, para preparar su contenido. */
export async function readyListing(h: ReturnType<typeof harness>, externalRef = "P-001") {
  const broker =
    (await h.brokers.findBySlug("marca")) ?? (await h.brokers.create(brokerData("marca")));
  const listing = await h.listings.create(newListing(broker.id, externalRef));
  await h.listings.promoteToReady(listing.id);
  await h.media.create({
    listingId: listing.id,
    brokerId: broker.id,
    kind: "image",
    storagePath: `brokers/${broker.id}/listings/${listing.id}/original/foto.jpg`,
    mime: "image/jpeg",
    bytes: 1000,
    checksum: `sha-${externalRef}`,
    sortOrder: 0,
    isCover: true,
  });
  return listing;
}

/** Textos sintéticos de los tres canales (datos inventados). */
export const sampleContents = (instagramBody = "Departamento luminoso en Ñuñoa."): NewContent[] =>
  (["instagram", "portal_inmobiliario", "fb_marketplace"] as const).map((platform) => ({
    platform,
    title: platform === "instagram" ? null : "Departamento en venta en Ñuñoa",
    body: platform === "instagram" ? instagramBody : "Departamento en venta en Ñuñoa.",
    hashtags:
      platform === "instagram"
        ? ["#nunoa", "#departamento", "#venta", "#santiago", "#propiedades"]
        : [],
    llmProvider: "fake",
    llmModel: "modelo-falso",
    promptVersion: "listing-content-v1",
    rawOutput: {},
  }));

/** Reporte sintético de una corrida completa. */
export const sampleContentReport = (): ContentRunReport => ({
  media: { processed: 1, existing: 0, failed: 0 },
  renders: { rendered: 2, existing: 0 },
  reel: "none",
  llm: {
    provider: "fake",
    model: "modelo-falso",
    promptVersion: "listing-content-v1",
    attempts: 1,
    durationMs: 12_000,
  },
  warnings: ["Foto 1: es angosta para Portal Inmobiliario (menos de 1200 px)"],
});

/** Hace de worker para la corrida de contenido más reciente de un aviso. */
export function simulateContentWorker(h: ReturnType<typeof harness>, listingId: string) {
  const runId = async () => {
    const run = await h.contentRuns.latest(listingId);
    if (run === null) throw new Error("no hay corridas");
    return run;
  };
  return {
    stage: async (stage: ContentRunStage) => {
      const run = await runId();
      await h.contentRuns.markRunning(run.id);
      await h.contentRuns.setStage(run.id, stage);
    },
    finish: async (contents = sampleContents()) => {
      const run = await runId();
      await h.contentRuns.markRunning(run.id);
      await h.contentRuns.markSucceeded(run.id, {
        report: sampleContentReport(),
        contents: run.texts ? contents : [],
      });
    },
    fail: async (code: string, message: string) => {
      const run = await runId();
      await h.contentRuns.markRunning(run.id);
      await h.contentRuns.markFailed(run.id, { code, message }, { warnings: [] });
    },
  };
}
