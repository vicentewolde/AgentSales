import { createHash, randomUUID } from "node:crypto";
import { AppError } from "@agentsales/core";
import {
  createInMemoryImportRunRepository,
  createInMemoryJobQueue,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { ROUTE_ACCESS } from "../access.js";
import {
  errorBodySchema,
  importRunListResponseSchema,
  importRunResponseSchema,
  importUploadResponseSchema,
} from "../contracts/index.js";
import { adminApp, testDeps, testStorage } from "../testing/index.js";

// F8-T06 (spec F8 §4.4 y §4.14, ADR-0025): pedir la carga con sus URLs de subida y empezarla. Los
// archivos los "sube" el test con `receiveUpload` (R2 en memoria), como el panel o la CLI.

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const XLSX = new Uint8Array([1, 2, 3, 4]);
const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);

function setup(overrides: Parameters<typeof testDeps>[0] = {}) {
  const importRuns = createInMemoryImportRunRepository({ nextId: randomUUID });
  const queue = createInMemoryJobQueue();
  const storage = testStorage();
  const app = adminApp(testDeps({ importRuns, queue, storage, ...overrides }));
  return { app, importRuns, queue, storage };
}

const post = (app: ReturnType<typeof adminApp>, path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const errorOf = async (response: Response) => errorBodySchema.parse(await response.json()).error;

const request = (extra: Record<string, unknown> = {}) => ({
  xlsx: { name: "propiedades.xlsx", size: XLSX.byteLength, sha256: sha256(XLSX) },
  ...extra,
});

describe("POST /imports/uploads", () => {
  it("crea la carga en awaiting_upload y responde una URL por archivo con sus cabeceras → 201", async () => {
    const { app, importRuns, queue } = setup();

    const response = await post(
      app,
      "/imports/uploads",
      request({
        broker: "marca",
        dryRun: true,
        media: {
          kind: "folder",
          name: "medios",
          files: [{ path: "P001/foto.jpg", size: PHOTO.byteLength, sha256: sha256(PHOTO) }],
        },
      }),
    );

    expect(response.status).toBe(201);
    const { importRun, uploads } = importUploadResponseSchema.parse(await response.json());
    expect(importRun).toMatchObject({
      status: "awaiting_upload",
      dryRun: true,
      input: { xlsxFile: "propiedades.xlsx", mediaFile: "medios", broker: "marca" },
    });
    expect(uploads.map(({ kind, name }) => ({ kind, name }))).toEqual([
      { kind: "xlsx", name: "propiedades.xlsx" },
      { kind: "file", name: "P001/foto.jpg" },
    ]);
    expect(uploads[0]?.headers).toEqual({
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "x-amz-checksum-sha256": createHash("sha256").update(XLSX).digest("base64"),
    });
    // La vista no muestra las claves de R2 (solo nombres); la carga no está en cola todavía.
    expect(JSON.stringify(importRun)).not.toContain("imports/");
    expect(await importRuns.get(importRun.id)).toMatchObject({ status: "awaiting_upload" });
    expect(queue.jobs).toEqual([]);
  });

  it("una ruta con .., un tope o un pedido mal formado se rechazan sin crear nada", async () => {
    const { app, importRuns } = setup();
    const folder = (path: string) =>
      request({
        media: { kind: "folder", name: "m", files: [{ path, size: 1, sha256: "a".repeat(64) }] },
      });

    const cases: [unknown, number, string][] = [
      [folder("../fuera.jpg"), 400, "IMPORT_UPLOAD_INVALID"],
      [
        request({ media: { kind: "zip", name: "m.zip", size: 51 * 1024 * 1024 } }),
        413,
        "IMPORT_UPLOAD_TOO_LARGE",
      ],
      [
        { xlsx: { name: "p.xlsx", size: 11 * 1024 * 1024, sha256: "a".repeat(64) } },
        413,
        "IMPORT_UPLOAD_TOO_LARGE",
      ],
      [{ xlsx: { name: "p.xlsx" } }, 400, "REQUEST_INVALID"],
    ];
    for (const [body, status, code] of cases) {
      const response = await post(app, "/imports/uploads", body);
      expect([code, response.status]).toEqual([code, status]);
      expect((await errorOf(response)).code).toBe(code);
    }
    expect(await importRuns.list(50, { kind: "all" })).toEqual([]);
  });
});

describe("POST /imports/:id/start", () => {
  async function requested(s: ReturnType<typeof setup>) {
    const response = await post(
      s.app,
      "/imports/uploads",
      request({
        media: {
          kind: "folder",
          name: "medios",
          files: [{ path: "P001/foto.jpg", size: PHOTO.byteLength, sha256: sha256(PHOTO) }],
        },
      }),
    );
    return importUploadResponseSchema.parse(await response.json());
  }

  it("con todo subido la pasa a queued y encola import.run → 202", async () => {
    const s = setup();
    const { importRun, uploads } = await requested(s);
    const [sheet, photo] = uploads;
    await s.storage.receiveUpload(sheet?.url ?? "", sheet?.headers ?? {}, XLSX);
    await s.storage.receiveUpload(photo?.url ?? "", photo?.headers ?? {}, PHOTO);

    const response = await post(s.app, `/imports/${importRun.id}/start`);

    expect(response.status).toBe(202);
    expect(importRunResponseSchema.parse(await response.json()).importRun.status).toBe("queued");
    expect(s.queue.jobs).toEqual([
      {
        name: "import.run",
        data: { importRunId: importRun.id },
        options: { singletonKey: importRun.id },
      },
    ]);
    // Empezar otra vez no encola de nuevo.
    expect((await post(s.app, `/imports/${importRun.id}/start`)).status).toBe(202);
    expect(s.queue.jobs).toHaveLength(1);
  });

  it("con un archivo faltante → 409 IMPORT_UPLOAD_INCOMPLETE con su nombre, y sigue esperando", async () => {
    const s = setup();
    const { importRun, uploads } = await requested(s);
    const [sheet] = uploads;
    await s.storage.receiveUpload(sheet?.url ?? "", sheet?.headers ?? {}, XLSX);

    const response = await post(s.app, `/imports/${importRun.id}/start`);

    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.code).toBe("IMPORT_UPLOAD_INCOMPLETE");
    expect(error.message).toContain("P001/foto.jpg");
    expect((await s.importRuns.get(importRun.id))?.status).toBe("awaiting_upload");
    expect(s.queue.jobs).toEqual([]);
  });

  it("con la cola caída → 503 QUEUE_UNAVAILABLE, la carga failed y sus archivos borrados", async () => {
    const s = setup({
      queue: {
        enqueue: async () => {
          throw new AppError("QUEUE_UNAVAILABLE", "La cola no responde", { retriable: true });
        },
      },
    });
    const { importRun, uploads } = await requested(s);
    for (const [index, body] of [XLSX, PHOTO].entries()) {
      await s.storage.receiveUpload(uploads[index]?.url ?? "", uploads[index]?.headers ?? {}, body);
    }

    const response = await post(s.app, `/imports/${importRun.id}/start`);

    expect(response.status).toBe(503);
    expect((await s.importRuns.get(importRun.id))?.status).toBe("failed");
    expect(await s.storage.list(`imports/${importRun.id}/`)).toEqual([]);
  });

  it("un id inexistente → 404; uno que no es uuid → 400", async () => {
    const { app } = setup();
    expect((await post(app, `/imports/${randomUUID()}/start`)).status).toBe(404);
    expect((await post(app, "/imports/run-1/start")).status).toBe(400);
  });
});

describe("las rutas de antes (F1) ya no existen", () => {
  it("POST /imports (multipart) y POST /imports/local responden 404, y no están en la tabla de permisos", async () => {
    const { app } = setup();
    const form = new FormData();
    form.append("file", new File([XLSX], "propiedades.xlsx"));

    const multipart = await app.request("/imports", {
      method: "POST",
      body: form,
      headers: { Origin: "http://localhost:5173" },
    });
    const local = await post(app, "/imports/local", { xlsxPath: "/tmp/p.xlsx" });

    expect(multipart.status).toBe(404);
    expect(local.status).toBe(404);
    expect(Object.keys(ROUTE_ACCESS)).not.toContain("POST /imports");
    expect(Object.keys(ROUTE_ACCESS)).not.toContain("POST /imports/local");
    expect(ROUTE_ACCESS["POST /imports/uploads"]).toBe("session");
    expect(ROUTE_ACCESS["POST /imports/:id/start"]).toBe("session");
  });
});

describe("GET /imports y /imports/:id", () => {
  it("muestran solo nombres de archivo: nunca claves de R2 ni rutas de una carga de antes de F8", async () => {
    const { app, importRuns } = setup();
    const legacy = await importRuns.create({
      source: "xlsx",
      fileName: "propiedades.xlsx",
      dryRun: false,
      input: {
        xlsxPath: "/Users/operador/secreto/propiedades.xlsx",
        mediaDir: "C:\\Users\\operador\\medios.zip",
        broker: null,
      },
    });
    const uploaded = importUploadResponseSchema.parse(
      await (await post(app, "/imports/uploads", request())).json(),
    ).importRun;

    const detail = await app.request(`/imports/${legacy.id}`);
    const list = await app.request("/imports");

    expect(detail.status).toBe(200);
    const detailText = await detail.text();
    expect(detailText).not.toContain("/Users/");
    expect(importRunResponseSchema.parse(JSON.parse(detailText)).importRun.input).toEqual({
      xlsxFile: "propiedades.xlsx",
      mediaFile: "medios.zip",
      broker: null,
    });
    const listText = await list.text();
    expect(listText).not.toContain("/Users/");
    expect(listText).not.toContain("imports/");
    expect(JSON.parse(listText).importRuns[0]).not.toHaveProperty("report");
    expect(
      importRunListResponseSchema.parse(JSON.parse(listText)).importRuns.map((r) => r.id),
    ).toEqual([uploaded.id, legacy.id]);
  });

  it("un id inexistente → 404 IMPORT_RUN_NOT_FOUND; uno que no es uuid → 400", async () => {
    const { app } = setup();
    const missing = await app.request(`/imports/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("IMPORT_RUN_NOT_FOUND");
    expect((await app.request("/imports/run-1")).status).toBe(400);
  });
});
