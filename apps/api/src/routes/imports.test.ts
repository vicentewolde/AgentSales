import { randomUUID } from "node:crypto";
import { AppError } from "@agentsales/core";
import {
  createInMemoryImportRunRepository,
  createInMemoryJobQueue,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { fakeUploads, testDeps } from "../../test/app-deps.js";
import { createApp } from "../app.js";
import {
  errorBodySchema,
  importRunListResponseSchema,
  importRunResponseSchema,
} from "../contracts/index.js";

const ORIGIN = "http://localhost:5173";

function setup(overrides: Parameters<typeof testDeps>[0] = {}) {
  const importRuns = createInMemoryImportRunRepository({ nextId: randomUUID });
  const queue = createInMemoryJobQueue();
  const uploads = fakeUploads();
  const app = createApp(testDeps({ importRuns, queue, uploads, ...overrides }));
  return { app, importRuns, queue, uploads };
}

/** Un archivo de `size` bytes (contenido sintético). */
const fileOf = (name: string, size = 16) => new File([new Uint8Array(size)], name);

function upload(
  app: ReturnType<typeof createApp>,
  fields: { file?: File; media?: File; broker?: string; dryRun?: string },
) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.append(key, value);
  }
  // El panel manda su Origin: sin él, `csrf()` rechaza un multipart (spec F1 §4.4).
  return app.request("/imports", { method: "POST", body: form, headers: { Origin: ORIGIN } });
}

const local = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request("/imports/local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const errorOf = async (response: Response) => errorBodySchema.parse(await response.json()).error;

describe("POST /imports (multipart)", () => {
  it("guarda los archivos, crea el run en queued, encola import.run y responde 202", async () => {
    const { app, queue, uploads } = setup();

    const response = await upload(app, {
      file: fileOf("propiedades.xlsx"),
      media: fileOf("medios.zip"),
      broker: "marca",
      dryRun: "true",
    });

    expect(response.status).toBe(202);
    const { importRun } = importRunResponseSchema.parse(await response.json());
    expect(importRun).toMatchObject({
      status: "queued",
      dryRun: true,
      fileName: "propiedades.xlsx",
      input: { xlsxFile: "propiedades.xlsx", mediaFile: "medios.zip", broker: "marca" },
    });
    expect([...(uploads.files.get(importRun.id)?.keys() ?? [])]).toEqual([
      "propiedades.xlsx",
      "medios.zip",
    ]);
    expect(queue.jobs).toEqual([
      {
        name: "import.run",
        data: { importRunId: importRun.id },
        options: { singletonKey: importRun.id },
      },
    ]);
  });

  it("todo el cuerpo sobre el tope → 413 REQUEST_TOO_LARGE, sin guardar nada", async () => {
    const { app, uploads } = setup({ maxUploadBytes: 1024 });

    const response = await upload(app, { file: fileOf("propiedades.xlsx", 4096) });

    expect(response.status).toBe(413);
    expect((await errorOf(response)).code).toBe("REQUEST_TOO_LARGE");
    expect(uploads.files.size).toBe(0);
  });

  it("un xlsx de más de 10 MB → 400 REQUEST_INVALID", async () => {
    const { app } = setup();

    const response = await upload(app, { file: fileOf("propiedades.xlsx", 10 * 1024 * 1024 + 1) });

    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe("REQUEST_INVALID");
    expect(error.message).toContain("10 MB");
  });

  it.each([
    ["sin Excel", { media: fileOf("medios.zip") }],
    ["un Excel que no es .xlsx", { file: fileOf("propiedades.csv") }],
    ["medios que no son .zip", { file: fileOf("propiedades.xlsx"), media: fileOf("fotos.rar") }],
  ])("%s → 400 REQUEST_INVALID", async (_, fields) => {
    const { app, queue } = setup();
    const response = await upload(app, fields);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("REQUEST_INVALID");
    expect(queue.jobs).toEqual([]);
  });

  it("cola caída → 503 QUEUE_UNAVAILABLE, run failed y archivos borrados", async () => {
    const queue = createInMemoryJobQueue({
      fail: () => new AppError("QUEUE_UNAVAILABLE", "La cola no está lista", { retriable: true }),
    });
    const { app, importRuns, uploads } = setup({ queue });

    const response = await upload(app, { file: fileOf("propiedades.xlsx") });

    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe("QUEUE_UNAVAILABLE");
    const [run] = await importRuns.list();
    expect(run).toMatchObject({ status: "failed", error: { code: "QUEUE_UNAVAILABLE" } });
    expect(uploads.files.size).toBe(0);
  });

  it("si la base no responde al crear el run, borra lo guardado", async () => {
    const importRuns = createInMemoryImportRunRepository({ nextId: randomUUID });
    importRuns.create = async () => {
      throw new AppError("DB_UNAVAILABLE", "La base de datos no responde", { retriable: true });
    };
    const { app, uploads } = setup({ importRuns });

    const response = await upload(app, { file: fileOf("propiedades.xlsx") });

    expect(response.status).toBe(503);
    expect(uploads.files.size).toBe(0);
  });
});

describe("POST /imports/local", () => {
  it("con rutas absolutas crea el run y encola → 202", async () => {
    const { app, queue } = setup();

    const response = await local(app, {
      xlsxPath: "/Users/operador/cargas/propiedades.xlsx",
      mediaDir: "/Users/operador/cargas/medios",
    });

    expect(response.status).toBe(202);
    const { importRun } = importRunResponseSchema.parse(await response.json());
    expect(importRun.input).toEqual({
      xlsxFile: "propiedades.xlsx",
      mediaFile: "medios",
      broker: null,
    });
    expect(queue.jobs).toHaveLength(1);
  });

  it("fuera de desarrollo (localImports false) → 404, aunque el cuerpo sea inválido", async () => {
    const { app } = setup({ localImports: false });
    for (const body of [{ xlsxPath: "/a.xlsx" }, { nada: true }]) {
      const response = await local(app, body);
      expect(response.status).toBe(404);
      expect((await errorOf(response)).code).toBe("ROUTE_NOT_FOUND");
    }
  });

  it("una ruta relativa → 400 REQUEST_INVALID", async () => {
    const { app } = setup();
    const response = await local(app, { xlsxPath: "cargas/propiedades.xlsx" });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("REQUEST_INVALID");
  });
});

describe("GET /imports y /imports/:id", () => {
  it("el detalle y la lista muestran solo nombres de archivo, nunca las rutas completas", async () => {
    const { app } = setup();
    const created = importRunResponseSchema.parse(
      await (
        await local(app, {
          xlsxPath: "/Users/operador/secreto/propiedades.xlsx",
          mediaDir: "C:\\Users\\operador\\medios.zip",
        })
      ).json(),
    ).importRun;

    const detail = await app.request(`/imports/${created.id}`);
    const list = await app.request("/imports");

    expect(detail.status).toBe(200);
    const detailText = await detail.text();
    expect(detailText).not.toContain("/Users/");
    expect(detailText).not.toContain("C:\\\\");
    expect(importRunResponseSchema.parse(JSON.parse(detailText)).importRun.input).toEqual({
      xlsxFile: "propiedades.xlsx",
      mediaFile: "medios.zip",
      broker: null,
    });
    const listText = await list.text();
    expect(listText).not.toContain("/Users/");
    expect(
      importRunListResponseSchema.parse(JSON.parse(listText)).importRuns.map((r) => r.id),
    ).toEqual([created.id]);
  });

  it("report puede ser null (el run falló antes de registrar)", async () => {
    const { app } = setup();
    const created = importRunResponseSchema.parse(
      await (await local(app, { xlsxPath: "/a/propiedades.xlsx" })).json(),
    ).importRun;
    const detail = importRunResponseSchema.parse(
      await (await app.request(`/imports/${created.id}`)).json(),
    );
    expect(detail.importRun.report).toBeNull();
  });

  it("un id inexistente → 404 IMPORT_RUN_NOT_FOUND; uno que no es uuid → 400", async () => {
    const { app } = setup();
    const missing = await app.request(`/imports/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("IMPORT_RUN_NOT_FOUND");
    expect((await app.request("/imports/run-1")).status).toBe(400);
  });
});
