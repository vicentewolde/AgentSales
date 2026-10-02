import { randomUUID } from "node:crypto";
import { type AppDeps, createApp, localAccess } from "@agentsales/api";
import { testDeps } from "@agentsales/api/testing";
import type { BrokerData, ImportReport, NewListing } from "@agentsales/core";
import {
  createInMemoryBrokerRepository,
  createInMemoryImportRunRepository,
  createInMemoryJobQueue,
  createInMemoryListingRepository,
  createInMemoryMediaRepository,
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
  const app = createApp(
    testDeps({
      access: localAccess(PORT, 5173),
      importRuns,
      listings,
      brokers,
      media,
      queue,
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
  };
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
