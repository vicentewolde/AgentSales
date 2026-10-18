// En Node (sin jsdom): el flujo de subida del panel (spec F8 §4.4, F8-T07) contra la API real en
// proceso, con R2 en memoria. El `PUT` del navegador (`XMLHttpRequest`) lo reemplaza un doble.
import { createHash } from "node:crypto";
import { createApp, localAccess } from "@agentsales/api";
import { testDeps, testStorage, withAdminSession } from "@agentsales/api/testing";
import { createInMemoryImportRunRepository } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { ApiError, createApiClient } from "./client.js";
import {
  checkFolder,
  folderSelection,
  type UploadDeps,
  UploadFailure,
  type UploadProgress,
  type UploadTransport,
  uploadImport,
} from "./upload.js";

function setup() {
  const storage = testStorage();
  const importRuns = createInMemoryImportRunRepository({
    nextId: () => "7f1c2a4e-9b3d-4f6a-8c2e-1d5b9a7e3f10",
  });
  const app = withAdminSession(
    createApp(testDeps({ access: localAccess(8787, 5173), storage, importRuns })),
  );
  const client = createApiClient("/api", {
    fetch: async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        "http://localhost:5173",
      );
      const headers = new Headers(init?.headers);
      headers.set("origin", "http://localhost:5173");
      return app.request(`http://localhost:5173${url.pathname.replace(/^\/api/, "")}`, {
        ...init,
        headers,
      });
    },
  });
  const memory: UploadTransport = async ({ url, headers, body, signal, onProgress }) => {
    if (signal.aborted) throw new DOMException("Subida cancelada", "AbortError");
    const bytes = new Uint8Array(await body.arrayBuffer());
    onProgress(bytes.byteLength);
    await storage.receiveUpload(url, headers, bytes);
  };
  const hash: UploadDeps["hash"] = async (blob) =>
    createHash("sha256")
      .update(new Uint8Array(await blob.arrayBuffer()))
      .digest("hex");
  return { client, storage, importRuns, memory, hash };
}

const xlsx = new File(["planilla"], "propiedades.xlsx");
const zip = new File(["zip de prueba"], "medios.zip");

describe("uploadImport", () => {
  it("calcula el sha256, pide las URLs, sube con avance y empieza la carga", async () => {
    const s = setup();
    const seen: UploadProgress[] = [];

    const run = await uploadImport(
      s.client,
      { file: xlsx, media: { kind: "zip", file: zip }, broker: "marca", dryRun: true },
      {
        transport: s.memory,
        hash: s.hash,
        signal: new AbortController().signal,
        onProgress: (p) => seen.push(p),
      },
    );

    expect(run).toMatchObject({
      status: "queued",
      dryRun: true,
      input: { mediaFile: "medios.zip" },
    });
    expect(seen.map((p) => p.phase)).toEqual(
      expect.arrayContaining(["hashing", "uploading", "starting"]),
    );
    const last = seen.filter((p) => p.phase === "uploading").at(-1);
    expect(last).toMatchObject({ sentBytes: 21, totalBytes: 21, doneFiles: 2, totalFiles: 2 });
    expect(await s.storage.list("imports/")).toHaveLength(2);
  });

  it("un fallo pasajero se reintenta (1 s, 2 s) y uno de la firma (403) no", async () => {
    const s = setup();
    const sleeps: number[] = [];
    let calls = 0;
    const flaky: UploadTransport = async (request) => {
      calls += 1;
      if (calls <= 2) throw new UploadFailure("No se pudo llegar a R2");
      return s.memory(request);
    };

    await uploadImport(
      s.client,
      { file: xlsx, media: null, dryRun: false },
      {
        transport: flaky,
        hash: s.hash,
        signal: new AbortController().signal,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(sleeps).toEqual([1_000, 2_000]);

    const forbidden: UploadTransport = async () => {
      throw new UploadFailure("R2 respondió 403", 403, "AccessDenied");
    };
    const error = await uploadImport(
      s.client,
      { file: xlsx, media: null, dryRun: false },
      {
        transport: forbidden,
        hash: s.hash,
        signal: new AbortController().signal,
        sleep: async () => {},
      },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "UPLOAD_FAILED" });
  });

  it("cancelar corta la subida y no empieza la carga", async () => {
    const s = setup();
    const controller = new AbortController();
    const hanging: UploadTransport = ({ signal }) =>
      new Promise((_, reject) => {
        controller.abort();
        if (signal.aborted) reject(new DOMException("Subida cancelada", "AbortError"));
      });

    const error = await uploadImport(
      s.client,
      { file: xlsx, media: null, dryRun: false },
      {
        transport: hanging,
        hash: s.hash,
        signal: controller.signal,
      },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "AbortError" });
    expect((await s.importRuns.list(1, { kind: "all" }))[0]?.status).toBe("awaiting_upload");
  });

  it("si un archivo no llegó, la API responde IMPORT_UPLOAD_INCOMPLETE al empezar", async () => {
    const s = setup();
    const lossy: UploadTransport = async (request) =>
      request.url.includes("media.zip") ? undefined : s.memory(request);

    const error = await uploadImport(
      s.client,
      { file: xlsx, media: { kind: "zip", file: zip }, dryRun: false },
      {
        transport: lossy,
        hash: s.hash,
        signal: new AbortController().signal,
      },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "IMPORT_UPLOAD_INCOMPLETE", status: 409 });
  });
});

describe("folderSelection", () => {
  const inFolder = (path: string) => {
    const file = new File(["x"], path.split("/").pop() ?? path);
    Object.defineProperty(file, "webkitRelativePath", { value: path });
    return file;
  };

  it("guarda el nombre de la carpeta, deja las rutas relativas a ella y salta los ocultos", () => {
    const folder = folderSelection([
      inFolder("medios/P001/foto.jpg"),
      inFolder("medios/.DS_Store"),
      inFolder("medios/__MACOSX/P001/._foto.jpg"),
    ]);

    expect(folder?.name).toBe("medios");
    expect(folder?.files.map((f) => f.path)).toEqual(["P001/foto.jpg"]);
  });

  it("una carpeta solo con ocultos no cuenta; más de 500 archivos se avisa", () => {
    expect(folderSelection([inFolder("medios/.DS_Store")])).toBeNull();
    const many = folderSelection(Array.from({ length: 501 }, (_, i) => inFolder(`m/${i}.jpg`)));
    expect(many && checkFolder(many)).toContain("más de 500 archivos");
  });
});

describe("timeout de un formulario con archivo (el logo)", () => {
  /** Responde después de `delayMs`, salvo que se aborte antes. */
  const slowFetch = (delayMs: number) => (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ status: "ok" })), delayMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal?.reason);
      });
    });
  const id = "7f1c2a4e-9b3d-4f6a-8c2e-1d5b9a7e3f10";
  const logo = () => new File(["x"], "logo.png");

  it("usa su propio tope, más largo que el de una consulta", async () => {
    const client = createApiClient("/api", {
      fetch: slowFetch(60),
      timeoutMs: 10,
      uploadTimeoutMs: 1_000,
    });

    const response = await client.brokers[":id"].logo.$post({
      param: { id },
      form: { logo: logo() },
    });

    expect(response.status).toBe(200);
  });

  it("una consulta sigue cortando con el tope corto", async () => {
    const client = createApiClient("/api", {
      fetch: slowFetch(60),
      timeoutMs: 10,
      uploadTimeoutMs: 1_000,
    });
    await expect(client.imports.$get()).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("una subida que vence su tope sugiere revisar si quedó hecha antes de reintentar", async () => {
    const client = createApiClient("/api", { fetch: slowFetch(1_000), uploadTimeoutMs: 20 });

    await expect(
      client.brokers[":id"].logo.$post({ param: { id }, form: { logo: logo() } }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      message: expect.stringContaining("revisa si quedó hecha antes de reintentar"),
    });
  });
});
