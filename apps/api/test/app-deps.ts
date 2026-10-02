import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createLogger, type Logger } from "@agentsales/config";
import {
  createInMemoryBrokerRepository,
  createInMemoryImportRunRepository,
  createInMemoryJobQueue,
  createInMemoryListingRepository,
  createInMemoryMediaRepository,
} from "@agentsales/core/testing";
import type { AppDeps } from "../src/app.js";

export const silentLogger: Logger = createLogger(
  { level: "silent" },
  new Writable({ write: (_chunk, _encoding, callback) => callback() }),
);

const ok = async () => {};

/** Archivos "guardados" por la API en un test: `runId → nombre → bytes`. */
export type FakeUploads = AppDeps["uploads"] & { files: Map<string, Map<string, Uint8Array>> };

export function fakeUploads(): FakeUploads {
  const files = new Map<string, Map<string, Uint8Array>>();
  return {
    files,
    async save(runId, fileName, bytes) {
      const run = files.get(runId) ?? new Map<string, Uint8Array>();
      run.set(fileName, bytes);
      files.set(runId, run);
      return `/workspace/tmp/imports/${runId}/input/${fileName}`;
    },
    async discard(runId) {
      files.delete(runId);
    },
  };
}

/**
 * Dependencias de la app con dobles en memoria (ids uuid, como en Postgres). `app.request("/x")`
 * usa http://localhost/x: el Host es "localhost", y el origen del panel, el 5173.
 */
export function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    checks: { db: ok, storage: ok, queue: ok },
    publishMode: "dry-run",
    version: "0.0.1",
    logger: silentLogger,
    access: { allowedHosts: ["localhost"], allowedOrigins: ["http://localhost:5173"] },
    listings: createInMemoryListingRepository({ nextId: randomUUID }),
    brokers: createInMemoryBrokerRepository(),
    media: createInMemoryMediaRepository(),
    storage: { signedReadUrl: async (path) => `https://r2.test/${path}?firma` },
    importRuns: createInMemoryImportRunRepository({ nextId: randomUUID }),
    queue: createInMemoryJobQueue(),
    uploads: fakeUploads(),
    newId: randomUUID,
    localImports: true,
    maxUploadBytes: 50 * 1024 * 1024,
    ...overrides,
  };
}
