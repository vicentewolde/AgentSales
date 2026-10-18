import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import type { UploadImportRunInput } from "../import-run.js";
import { createInMemoryImportRunRepository } from "../testing/import-repositories.js";
import { createInMemoryJobQueue } from "../testing/job-queue.js";
import { createInMemoryMediaStorage } from "../testing/media.js";
import {
  closeAbandonedImports,
  IMPORT_UPLOAD,
  type RequestImportUploadParams,
  relativePathIssue,
  requestImportUpload,
  startImport,
} from "./request-import.js";

// F8-T04 (spec F8 §4.4, ADR-0025): pedir la carga con sus URLs de subida, empezarla cuando están
// todos sus archivos en R2 y cerrar las que nadie terminó de subir.

const SHA = "a".repeat(64);
const MB = 1024 * 1024;
let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

function setup(options: { now?: () => Date } = {}) {
  const importRuns = createInMemoryImportRunRepository(options.now ? { now: options.now } : {});
  const storage = createInMemoryMediaStorage();
  const queue = createInMemoryJobQueue();
  const request = (params: Partial<RequestImportUploadParams> = {}) =>
    requestImportUpload(
      { importRuns, storage, newId, maxFileBytes: 512 * MB },
      {
        broker: null,
        brokerId: null,
        dryRun: false,
        xlsx: { name: "propiedades.xlsx", size: 1000, sha256: SHA },
        media: null,
        ...params,
      },
    );
  /** Sube a R2 (el doble) los archivos de la carga con su tamaño anunciado. */
  const uploadAll = async (input: UploadImportRunInput, skip: string[] = []) => {
    const put = (key: string, size: number) => storage.put(key, new Uint8Array(size), "x");
    if (!skip.includes(input.xlsx.name)) await put(input.xlsx.key, input.xlsx.size);
    if (input.media?.kind === "zip" && !skip.includes(input.media.name)) {
      await put(input.media.key, input.media.size);
    }
    if (input.media?.kind === "folder") {
      for (const file of input.media.files) {
        if (!skip.includes(file.path)) await put(`${input.media.prefix}${file.path}`, file.size);
      }
    }
  };
  const start = (importRunId: string) =>
    startImport({ importRuns, storage, queue }, { importRunId });
  return { importRuns, storage, queue, request, uploadAll, start };
}

const folder = (files: { path: string; size?: number; sha256?: string }[]) => ({
  kind: "folder" as const,
  name: "medios",
  files: files.map((file) => ({ size: 3, sha256: SHA, ...file })),
});

async function caught(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

const asUpload = (input: unknown) => input as UploadImportRunInput;

describe("requestImportUpload", () => {
  it("crea la carga en awaiting_upload con su corredor y dryRun, y una URL por archivo", async () => {
    const s = setup();
    const { run, uploads } = await s.request({
      broker: "marca",
      brokerId: "broker-1",
      dryRun: true,
      media: folder([
        { path: "P001/foto.jpg" },
        { path: "P002/video.mp4", size: 200 * MB, sha256: undefined },
      ]),
    });

    expect(run).toMatchObject({
      status: "awaiting_upload",
      brokerId: "broker-1",
      dryRun: true,
      fileName: "propiedades.xlsx",
    });
    const input = asUpload(run.input);
    expect(input).toEqual({
      broker: "marca",
      dryRun: true,
      xlsx: {
        key: `imports/${run.id}/xlsx/propiedades.xlsx`,
        name: "propiedades.xlsx",
        size: 1000,
        sha256: SHA,
      },
      media: {
        kind: "folder",
        prefix: `imports/${run.id}/media/`,
        name: "medios",
        files: [
          { path: "P001/foto.jpg", size: 3, sha256: SHA },
          { path: "P002/video.mp4", size: 200 * MB },
        ],
      },
    });
    expect(uploads.map(({ kind, name }) => ({ kind, name }))).toEqual([
      { kind: "xlsx", name: "propiedades.xlsx" },
      { kind: "file", name: "P001/foto.jpg" },
      { kind: "file", name: "P002/video.mp4" },
    ]);
    // La planilla firma su sha256; un archivo grande sin sha256, solo su tipo.
    expect(uploads[0]?.headers).toMatchObject({ "x-amz-checksum-sha256": expect.any(String) });
    expect(uploads[2]?.headers).toEqual({ "content-type": "application/octet-stream" });
    expect(uploads[0]?.url).toContain(`imports/${run.id}/xlsx/propiedades.xlsx`);
    expect(uploads[0]?.url).toContain(`ttl=${IMPORT_UPLOAD.urlTtlSeconds}`);
    expect(IMPORT_UPLOAD.urlTtlSeconds).toBe(6 * 60 * 60);
  });

  it("un zip va con su tamaño, sin sha256", async () => {
    const s = setup();
    const { run, uploads } = await s.request({
      media: { kind: "zip", name: "medios.zip", size: 300 * MB },
    });

    expect(asUpload(run.input).media).toEqual({
      kind: "zip",
      key: `imports/${run.id}/media.zip`,
      name: "medios.zip",
      size: 300 * MB,
    });
    expect(uploads[1]).toMatchObject({
      kind: "zip",
      headers: { "content-type": "application/zip" },
    });
  });

  it.each([
    ["../P001/foto.jpg", "con un tramo no permitido"],
    ["P001/../../x.jpg", "con un tramo no permitido"],
    ["/etc/passwd", "absoluta"],
    ["C:/fotos/a.jpg", "absoluta"],
    ["P001\\foto.jpg", "con \\"],
    ["P001/fo\u0000to.jpg", "con caracteres de control"],
    ["P001//foto.jpg", "con un tramo no permitido"],
    ["P001/./foto.jpg", "con un tramo no permitido"],
  ])("rechaza la ruta %j (%s) al pedir la subida, sin crear nada", async (path, reason) => {
    const s = setup();
    expect(relativePathIssue(path)).toBe(reason);

    expect(await caught(s.request({ media: folder([{ path }]) }))).toMatchObject({
      code: "IMPORT_UPLOAD_INVALID",
    });
    expect(await s.importRuns.list(50, { kind: "all" })).toEqual([]);
  });

  it.each<[string, Partial<RequestImportUploadParams>, string]>([
    [
      "un Excel de más de 10 MB",
      { xlsx: { name: "p.xlsx", size: 10 * MB + 1, sha256: SHA } },
      "IMPORT_UPLOAD_TOO_LARGE",
    ],
    [
      "un Excel que no es .xlsx",
      { xlsx: { name: "p.xls", size: 10, sha256: SHA } },
      "IMPORT_UPLOAD_INVALID",
    ],
    ["un Excel vacío", { xlsx: { name: "p.xlsx", size: 0, sha256: SHA } }, "IMPORT_UPLOAD_INVALID"],
    [
      "un Excel sin sha256",
      { xlsx: { name: "p.xlsx", size: 10, sha256: "x" } },
      "IMPORT_UPLOAD_INVALID",
    ],
    [
      "un nombre con carpetas",
      { xlsx: { name: "../p.xlsx", size: 10, sha256: SHA } },
      "IMPORT_UPLOAD_INVALID",
    ],
    [
      "un zip sobre el tope de cada archivo",
      { media: { kind: "zip", name: "m.zip", size: 512 * MB + 1 } },
      "IMPORT_UPLOAD_TOO_LARGE",
    ],
    [
      "medios que no son .zip",
      { media: { kind: "zip", name: "m.rar", size: 10 } },
      "IMPORT_UPLOAD_INVALID",
    ],
    [
      "una carpeta de más de 500 archivos",
      { media: folder(Array.from({ length: 501 }, (_, i) => ({ path: `P/${i}.jpg` }))) },
      "IMPORT_UPLOAD_INVALID",
    ],
    [
      "un archivo de la carpeta sobre el tope",
      { media: folder([{ path: "P/v.mp4", size: 512 * MB + 1 }]) },
      "IMPORT_UPLOAD_TOO_LARGE",
    ],
    [
      "un archivo chico sin sha256",
      { media: folder([{ path: "P/a.jpg", sha256: undefined }]) },
      "IMPORT_UPLOAD_INVALID",
    ],
    [
      "archivos repetidos (sin mayúsculas)",
      { media: folder([{ path: "P/Foto.jpg" }, { path: "P/foto.jpg" }]) },
      "IMPORT_UPLOAD_INVALID",
    ],
    ["una carpeta vacía", { media: folder([]) }, "IMPORT_UPLOAD_INVALID"],
  ])("rechaza %s", async (_label, params, code) => {
    const s = setup();

    expect(await caught(s.request(params))).toMatchObject({ code });
    expect(await s.importRuns.list(50, { kind: "all" })).toEqual([]);
  });

  it("una carpeta que suma más de 4 GB se rechaza aunque cada archivo pase", async () => {
    const s = setup();
    const files = Array.from({ length: 9 }, (_, i) => ({ path: `P/${i}.mp4`, size: 500 * MB }));

    expect(await caught(s.request({ media: folder(files) }))).toMatchObject({
      code: "IMPORT_UPLOAD_TOO_LARGE",
    });
  });
});

describe("startImport", () => {
  it("con todos los archivos en R2 la pasa a queued y encola import.run una vez", async () => {
    const s = setup();
    const { run } = await s.request({ media: folder([{ path: "P001/a.jpg" }]) });
    await s.uploadAll(asUpload(run.input));

    const started = await s.start(run.id);

    expect(started.status).toBe("queued");
    expect((await s.importRuns.get(run.id))?.status).toBe("queued");
    expect(s.queue.jobs).toEqual([
      { name: "import.run", data: { importRunId: run.id }, options: { singletonKey: run.id } },
    ]);
  });

  it("si falta un archivo, o tiene otro tamaño: IMPORT_UPLOAD_INCOMPLETE con sus nombres, y sigue esperando", async () => {
    const s = setup();
    const { run } = await s.request({
      media: folder([{ path: "P001/a.jpg" }, { path: "P001/b.jpg" }]),
    });
    const input = asUpload(run.input);
    await s.uploadAll(input, ["P001/b.jpg"]);
    await s.storage.put(`imports/${run.id}/media/P001/a.jpg`, new Uint8Array(2), "x");

    const error = await caught(s.start(run.id));

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "IMPORT_UPLOAD_INCOMPLETE",
      details: { missing: ["P001/a.jpg", "P001/b.jpg"], count: 2 },
    });
    expect((await s.importRuns.get(run.id))?.status).toBe("awaiting_upload");
    expect(s.queue.jobs).toEqual([]);

    // Sube lo que falta y vuelve a empezar.
    await s.uploadAll(input);
    expect((await s.start(run.id)).status).toBe("queued");
  });

  it("empezar dos veces encola con la misma clave, y una en curso no se toca", async () => {
    const s = setup();
    const { run } = await s.request();
    await s.uploadAll(asUpload(run.input));

    await s.start(run.id);
    const again = await s.start(run.id);

    // La segunda vez vuelve a encolar con la misma clave (pg-boss no duplica un job vivo): así
    // repara una carga que quedó en cola sin job por un corte.
    expect(again.status).toBe("queued");
    expect(s.queue.jobs.map((job) => job.options)).toEqual([
      { singletonKey: run.id },
      { singletonKey: run.id },
    ]);

    // Una carga ya en curso no se vuelve a encolar.
    await s.importRuns.markRunning(run.id);
    expect((await s.start(run.id)).status).toBe("running");
    expect(s.queue.jobs).toHaveLength(2);
  });

  it("una carga que no existe es IMPORT_RUN_NOT_FOUND", async () => {
    const s = setup();
    expect(await caught(s.start(newId()))).toMatchObject({ code: "IMPORT_RUN_NOT_FOUND" });
  });

  it("con la cola caída la deja en failed y borra sus archivos de R2", async () => {
    const importRuns = createInMemoryImportRunRepository();
    const storage = createInMemoryMediaStorage();
    const queue = {
      enqueue: async () => {
        throw new AppError("QUEUE_UNAVAILABLE", "La cola no responde", { retriable: true });
      },
    };
    const { run } = await requestImportUpload(
      { importRuns, storage, newId, maxFileBytes: MB },
      {
        broker: null,
        brokerId: null,
        dryRun: false,
        xlsx: { name: "p.xlsx", size: 5, sha256: SHA },
        media: null,
      },
    );
    await storage.put(asUpload(run.input).xlsx.key, new Uint8Array(5), "x");

    expect(
      await caught(startImport({ importRuns, storage, queue }, { importRunId: run.id })),
    ).toMatchObject({
      code: "QUEUE_UNAVAILABLE",
    });
    expect(await importRuns.get(run.id)).toMatchObject({
      status: "failed",
      error: { code: "QUEUE_UNAVAILABLE" },
    });
    expect(await storage.list(`imports/${run.id}/`)).toEqual([]);
  });
});

describe("closeAbandonedImports", () => {
  it("a las 24 h cierra la que espera y borra sus objetos; deja la reciente y la que está en cola", async () => {
    let clock = new Date("2026-10-18T12:00:00Z");
    const s = setup({ now: () => clock });
    const vieja = (await s.request()).run;
    await s.uploadAll(asUpload(vieja.input));
    clock = new Date("2026-10-19T11:00:00Z");
    const reciente = (await s.request()).run;
    const enCola = (await s.request()).run;
    await s.uploadAll(asUpload(enCola.input));
    await s.start(enCola.id);

    const before = await closeAbandonedImports({
      importRuns: s.importRuns,
      storage: s.storage,
      now: () => new Date("2026-10-19T11:59:00Z"),
    });
    expect(before.abandoned).toEqual([]);

    const result = await closeAbandonedImports({
      importRuns: s.importRuns,
      storage: s.storage,
      now: () => new Date("2026-10-19T12:00:01Z"),
    });

    expect(result).toMatchObject({ abandoned: [vieja.id], deletedObjects: 1, failed: [] });
    expect(await s.importRuns.get(vieja.id)).toMatchObject({
      status: "failed",
      error: { code: "IMPORT_UPLOAD_ABANDONED" },
    });
    expect(await s.storage.list(`imports/${vieja.id}/`)).toEqual([]);
    expect((await s.importRuns.get(reciente.id))?.status).toBe("awaiting_upload");
    expect(await s.storage.list(`imports/${enCola.id}/`)).toHaveLength(1);
  });

  it("recoge los objetos que quedaron de una carga terminada y los de una que no existe, pasadas 24 h", async () => {
    let clock = new Date("2026-10-18T12:00:00Z");
    const s = setup({ now: () => clock });
    const terminada = (await s.request()).run;
    await s.uploadAll(asUpload(terminada.input));
    await s.start(terminada.id);
    await s.importRuns.markRunning(terminada.id);
    await s.importRuns.markSucceeded(terminada.id);
    const storage = createInMemoryMediaStorage({ now: () => clock });
    await storage.put(asUpload(terminada.input).xlsx.key, new Uint8Array(1000), "x");
    await storage.put(
      "imports/00000000-0000-4000-8000-999999999999/xlsx/p.xlsx",
      new Uint8Array(1),
      "x",
    );
    clock = new Date("2026-10-19T13:00:00Z");
    await storage.put(
      "imports/00000000-0000-4000-8000-888888888888/xlsx/p.xlsx",
      new Uint8Array(1),
      "x",
    );

    const result = await closeAbandonedImports({
      importRuns: s.importRuns,
      storage,
      now: () => clock,
    });

    expect(result.deletedObjects).toBe(2);
    expect((await storage.list("imports/")).map((object) => object.path)).toEqual([
      "imports/00000000-0000-4000-8000-888888888888/xlsx/p.xlsx",
    ]);
  });
});
