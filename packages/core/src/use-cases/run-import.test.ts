import { describe, expect, it } from "vitest";
import { AppError, isAppError } from "../errors.js";
import type { FieldDefinition } from "../field-definition.js";
import type { ListingSheetInput } from "../listing-sheet.js";
import { createInMemoryFieldDefinitionRepository } from "../testing/field-definition-repository.js";
import {
  createInMemoryBrokerRepository,
  createInMemoryImportRunRepository,
  createInMemoryListingRepository,
} from "../testing/import-repositories.js";
import { createInMemoryJobQueue } from "../testing/job-queue.js";
import {
  createInMemoryMediaFileSource,
  createInMemoryMediaRepository,
  createInMemoryMediaStorage,
  type InMemoryMediaStorageOptions,
  memoryFile,
} from "../testing/media.js";
import { requestImport } from "./request-import.js";
import { type RunImportDeps, runImport } from "./run-import.js";

let nextDef = 0;
const def = (
  key: string,
  type: FieldDefinition["type"],
  overrides: Partial<FieldDefinition> = {},
): FieldDefinition => ({
  id: `def-${++nextDef}`,
  brokerId: null,
  category: "real_estate",
  key,
  label: key,
  type,
  required: false,
  options: null,
  sourceColumn: key,
  isCore: true,
  sortOrder: nextDef * 10,
  active: true,
  ...overrides,
});

const DEFS = [
  def("id_propiedad", "text", { required: true }),
  def("precio", "number", { required: true }),
  def("moneda", "enum", { required: true, options: ["UF", "CLP"] }),
  def("estado_carga", "enum", { options: ["Borrador", "Listo"] }),
];

/** Hoja sintética con una propiedad (datos inventados). */
const SHEET: ListingSheetInput = {
  headers: DEFS.map((d) => d.sourceColumn),
  rows: [
    {
      rowNumber: 2,
      raw: { id_propiedad: "P001", precio: 5800, moneda: "UF", estado_carga: "Listo" },
    },
  ],
  broker: { nombre_corredor: "Persona", nombre_marca: "Marca", color_primario: "#112233" },
};

const FOLDERS = { P001: { files: [memoryFile("P001/foto1.jpg", "foto-uno")] } };

const INPUT = { xlsxPath: "/tmp/propiedades.xlsx", mediaDir: "/tmp/medios", broker: null };

const unavailable = () =>
  new AppError("STORAGE_UNAVAILABLE", "R2 no respondió", { retriable: true });

function setup(storageOptions: InMemoryMediaStorageOptions = {}) {
  const media = createInMemoryMediaRepository();
  const calls = {
    readSheet: 0,
    openMedia: 0,
    close: 0,
    discarded: [] as string[],
    folders: [] as (readonly string[])[],
  };
  const listings = createInMemoryListingRepository();
  const deps = {
    brokers: createInMemoryBrokerRepository([], { media }),
    listings,
    importRuns: createInMemoryImportRunRepository(),
    fieldDefinitions: createInMemoryFieldDefinitionRepository(DEFS),
    media,
    storage: createInMemoryMediaStorage(storageOptions),
    sha256: async (text: string) => `hash:${text}`,
    readSheet: async () => {
      calls.readSheet += 1;
      return SHEET;
    },
    openMedia: async (_run: unknown, folders: readonly string[]) => {
      calls.openMedia += 1;
      calls.folders.push(folders);
      return {
        source: createInMemoryMediaFileSource(FOLDERS),
        close: async () => {
          calls.close += 1;
        },
      };
    },
    discardStaging: async (runId: string) => {
      calls.discarded.push(runId);
    },
  } satisfies RunImportDeps & { listings: typeof listings; media: typeof media };
  const createRun = () =>
    deps.importRuns.create({
      source: "xlsx",
      fileName: "propiedades.xlsx",
      dryRun: false,
      input: INPUT,
    });
  return { deps, calls, createRun };
}

async function caught(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("runImport", () => {
  it("éxito: running → succeeded, importa, sube los medios, libera y borra el staging", async () => {
    const { deps, calls, createRun } = setup();
    const run = await createRun();

    const result = await runImport(deps, { importRunId: run.id, isLastAttempt: false });

    expect(result).toEqual({ outcome: "succeeded" });
    const done = await deps.importRuns.get(run.id);
    expect(done).toMatchObject({ status: "succeeded", rowsCreated: 1, error: null });
    expect(done?.startedAt).toBeInstanceOf(Date);
    expect(done?.finishedAt).toBeInstanceOf(Date);
    expect(done?.report?.media).toMatchObject({ filesUploaded: 1 });
    expect(deps.listings.all()[0]?.status).toBe("ready");
    expect(calls).toMatchObject({ readSheet: 1, openMedia: 1, close: 1, discarded: [run.id] });
    // Las carpetas que la carga va a pedir: la de la fila (sin carpeta_medios, su id).
    expect(calls.folders).toEqual([["P001"]]);
  });

  it("STORAGE_UNAVAILABLE en un intento que no es el último: se propaga y el run sigue en running", async () => {
    const { deps, calls, createRun } = setup({ failUpload: unavailable });
    const run = await createRun();

    const error = await caught(runImport(deps, { importRunId: run.id, isLastAttempt: false }));

    expect(isAppError(error) && error.code).toBe("STORAGE_UNAVAILABLE");
    expect((await deps.importRuns.get(run.id))?.status).toBe("running");
    // Los medios se liberan siempre; el staging se conserva para el reintento.
    expect(calls).toMatchObject({ close: 1, discarded: [] });
  });

  it("el mismo error en el último intento: failed con error antes de relanzar, y staging borrado", async () => {
    const { deps, calls, createRun } = setup({ failUpload: unavailable });
    const run = await createRun();

    const error = await caught(runImport(deps, { importRunId: run.id, isLastAttempt: true }));

    expect(isAppError(error) && error.code).toBe("STORAGE_UNAVAILABLE");
    expect(await deps.importRuns.get(run.id)).toMatchObject({
      status: "failed",
      error: { code: "STORAGE_UNAVAILABLE", message: "R2 no respondió" },
    });
    expect(calls.discarded).toEqual([run.id]);
  });

  it("un error no reintentable deja el run en failed aunque no sea el último intento", async () => {
    const { deps, calls, createRun } = setup();
    deps.readSheet = async () => {
      throw new AppError("IMPORT_FILE_INVALID", "El archivo no es un Excel (.xlsx) válido");
    };
    const run = await createRun();

    const error = await caught(runImport(deps, { importRunId: run.id, isLastAttempt: false }));

    expect(isAppError(error) && error.code).toBe("IMPORT_FILE_INVALID");
    expect(await deps.importRuns.get(run.id)).toMatchObject({
      status: "failed",
      error: { code: "IMPORT_FILE_INVALID", message: "El archivo no es un Excel (.xlsx) válido" },
    });
    expect(calls).toMatchObject({ openMedia: 0, discarded: [run.id] });
  });

  it("un zip inválido al preparar los medios deja el run en failed", async () => {
    const { deps, createRun } = setup();
    deps.openMedia = async () => {
      throw new AppError("IMPORT_FILE_INVALID", "El zip medios.zip no es válido o está dañado");
    };
    const run = await createRun();

    await caught(runImport(deps, { importRunId: run.id, isLastAttempt: false }));

    expect((await deps.importRuns.get(run.id))?.error?.code).toBe("IMPORT_FILE_INVALID");
  });

  it("un error que no es AppError: failed con un mensaje genérico, sin el detalle", async () => {
    const { deps, createRun } = setup();
    deps.readSheet = async () => {
      throw new Error("ENOENT: /Users/alguien/secreto.xlsx");
    };
    const run = await createRun();

    await caught(runImport(deps, { importRunId: run.id, isLastAttempt: false }));

    expect((await deps.importRuns.get(run.id))?.error).toEqual({
      code: "INTERNAL_ERROR",
      message: "Error interno al importar",
    });
  });

  it.each(["succeeded", "failed"] as const)("un run ya en %s no hace nada", async (status) => {
    const { deps, calls, createRun } = setup();
    const run = await createRun();
    await deps.importRuns.markRunning(run.id);
    if (status === "succeeded") await deps.importRuns.markSucceeded(run.id);
    else await deps.importRuns.markFailed(run.id, { code: "X", message: "antes" });
    const before = await deps.importRuns.get(run.id);

    const result = await runImport(deps, { importRunId: run.id, isLastAttempt: false });

    expect(result).toEqual({ outcome: "skipped", status });
    expect(await deps.importRuns.get(run.id)).toEqual(before);
    expect(calls).toMatchObject({ readSheet: 0, openMedia: 0, discarded: [] });
  });

  it("un reintento tras un fallo reintentable termina sin duplicar nada", async () => {
    let r2Down = true;
    const { deps, createRun } = setup({ failUpload: () => (r2Down ? unavailable() : undefined) });
    const run = await createRun();
    await caught(runImport(deps, { importRunId: run.id, isLastAttempt: false }));

    r2Down = false;
    const result = await runImport(deps, { importRunId: run.id, isLastAttempt: true });

    expect(result).toEqual({ outcome: "succeeded" });
    expect(deps.listings.all()).toHaveLength(1);
    expect(deps.media.all().filter((item) => item.listingId !== null)).toHaveLength(1);
    expect(await deps.importRuns.get(run.id)).toMatchObject({
      status: "succeeded",
      rowsSkipped: 1,
    });
  });

  it("si la base no responde al marcar failed, se propaga ese error (reintentable)", async () => {
    const { deps, createRun } = setup();
    deps.readSheet = async () => {
      throw new AppError("IMPORT_FILE_INVALID", "inválido");
    };
    deps.importRuns.markFailed = async () => {
      throw new AppError("DB_UNAVAILABLE", "La base de datos no responde", { retriable: true });
    };
    const run = await createRun();

    const error = await caught(runImport(deps, { importRunId: run.id, isLastAttempt: false }));

    expect(isAppError(error) && [error.code, error.retriable]).toEqual(["DB_UNAVAILABLE", true]);
  });

  it("un run inexistente → IMPORT_RUN_NOT_FOUND", async () => {
    const { deps } = setup();
    const error = await caught(runImport(deps, { importRunId: "run-nadie", isLastAttempt: false }));
    expect(isAppError(error) && error.code).toBe("IMPORT_RUN_NOT_FOUND");
  });
});

describe("requestImport", () => {
  const params = {
    source: "xlsx",
    fileName: "propiedades.xlsx",
    dryRun: false,
    input: INPUT,
  } as const;

  it("crea el run en queued y encola import.run con su id como singletonKey", async () => {
    const importRuns = createInMemoryImportRunRepository();
    const queue = createInMemoryJobQueue();
    const discarded: string[] = [];

    const run = await requestImport(
      { importRuns, queue, discardStaging: async (id) => void discarded.push(id) },
      params,
    );

    expect(run).toMatchObject({ status: "queued", fileName: "propiedades.xlsx", input: INPUT });
    expect(queue.jobs).toEqual([
      { name: "import.run", data: { importRunId: run.id }, options: { singletonKey: run.id } },
    ]);
    expect(discarded).toEqual([]);
  });

  it("si la cola no está disponible: run failed con QUEUE_UNAVAILABLE, staging borrado y error", async () => {
    const importRuns = createInMemoryImportRunRepository();
    const queue = createInMemoryJobQueue({
      fail: () => new AppError("QUEUE_UNAVAILABLE", "La cola no está lista", { retriable: true }),
    });
    const discarded: string[] = [];

    const error = await caught(
      requestImport(
        { importRuns, queue, discardStaging: async (id) => void discarded.push(id) },
        params,
      ),
    );

    expect(isAppError(error) && error.code).toBe("QUEUE_UNAVAILABLE");
    const [runId] = discarded;
    expect(await importRuns.get(runId ?? "")).toMatchObject({
      status: "failed",
      error: { code: "QUEUE_UNAVAILABLE", message: "La cola no está lista" },
    });
  });

  it("otro error al encolar (un bug) se propaga sin tocar el run ni el staging", async () => {
    const importRuns = createInMemoryImportRunRepository();
    const queue = createInMemoryJobQueue({
      fail: () => new AppError("JOB_PAYLOAD_INVALID", "Datos inválidos para el job import.run"),
    });
    const discarded: string[] = [];

    const error = await caught(
      requestImport(
        { importRuns, queue, discardStaging: async (id) => void discarded.push(id) },
        params,
      ),
    );

    expect(isAppError(error) && error.code).toBe("JOB_PAYLOAD_INVALID");
    expect(discarded).toEqual([]);
    expect((await importRuns.get("run-1"))?.status).toBe("queued");
  });
});
