import { Writable } from "node:stream";
import { createLogger } from "@agentsales/config";
import { AppError, type RunImportDeps } from "@agentsales/core";
import {
  createInMemoryBrokerRepository,
  createInMemoryFieldDefinitionRepository,
  createInMemoryImportRunRepository,
  createInMemoryListingRepository,
  createInMemoryMediaRepository,
  createInMemoryMediaStorage,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { IMPORT_RUN_QUEUE, importRunJob } from "./import-run.js";
import { buildJobs } from "./index.js";

const logger = createLogger(
  { level: "silent" },
  new Writable({ write: (_chunk, _encoding, callback) => callback() }),
);

/** Dependencias en memoria; el run lleva un uuid, porque el job valida su id con `JOB_PAYLOADS`. */
function deps(): RunImportDeps & {
  importRuns: ReturnType<typeof createInMemoryImportRunRepository>;
} {
  return {
    brokers: createInMemoryBrokerRepository(),
    listings: createInMemoryListingRepository(),
    importRuns: createInMemoryImportRunRepository({
      nextId: () => "7f1c2a4e-9b3d-4f6a-8c2e-1d5b9a7e3f10",
    }),
    fieldDefinitions: createInMemoryFieldDefinitionRepository([]),
    media: createInMemoryMediaRepository(),
    storage: createInMemoryMediaStorage(),
    sha256: async (text) => `hash:${text}`,
    readSheet: async () => {
      throw new AppError("IMPORT_FILE_INVALID", "El archivo no es un Excel (.xlsx) válido");
    },
    openMedia: async () => ({ source: null, close: async () => {} }),
    discardStaging: async () => {},
  };
}

describe("job import.run", () => {
  it("la cola es exclusive (deduplica por importRunId), con 2 reintentos con backoff y 2 h", () => {
    expect(IMPORT_RUN_QUEUE).toEqual({
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 7200,
    });
    expect(buildJobs({ importRun: deps() }).map((job) => job.name)).toEqual([
      "system.ping",
      "import.run",
    ]);
  });

  it("corre runImport con el run del job: un error deja el run en failed y se relanza", async () => {
    const d = deps();
    const run = await d.importRuns.create({
      source: "xlsx",
      fileName: "p.xlsx",
      dryRun: false,
      input: { xlsxPath: "/tmp/p.xlsx", mediaDir: null, broker: null },
    });

    await expect(
      importRunJob(d).run({ importRunId: run.id }, { jobId: "j1", logger, isLastAttempt: false }),
    ).rejects.toMatchObject({ code: "IMPORT_FILE_INVALID" });
    expect(await d.importRuns.get(run.id)).toMatchObject({
      status: "failed",
      error: { code: "IMPORT_FILE_INVALID" },
    });
  });

  it("con datos que no son un uuid: JOB_PAYLOAD_INVALID, sin tocar nada", async () => {
    await expect(
      importRunJob(deps()).run(
        { importRunId: "run-1" },
        { jobId: "j2", logger, isLastAttempt: true },
      ),
    ).rejects.toMatchObject({ code: "JOB_PAYLOAD_INVALID" });
  });
});
