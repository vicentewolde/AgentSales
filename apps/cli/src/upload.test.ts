import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "./output.js";
import { buildImportManifest, createNodePutFile, UploadError, uploadAll } from "./upload.js";

// La subida de la CLI a R2 (spec F8 §4.5, F8-T09): el `PUT` de verdad contra un servidor local que
// hace de R2 (sin red externa), y el armado del pedido desde el disco.

let dir: string;
let server: Server | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentsales-cli-upload-"));
});
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

type Received = { method: string; headers: IncomingMessage["headers"]; body: Buffer };

/** Un R2 local: responde con `respond` (por intento) y guarda lo recibido. */
async function fakeR2(respond: (attempt: number) => { status: number; body?: string }) {
  const received: Received[] = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        method: request.method ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      const { status, body } = respond(received.length);
      response.writeHead(status, { "content-type": "application/xml" });
      response.end(body ?? "");
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/imports/r1/xlsx/p.xlsx?X-Amz-Signature=firma`, received };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("createNodePutFile", () => {
  it("manda el archivo en streaming con Content-Length y las cabeceras firmadas tal cual", async () => {
    const r2 = await fakeR2(() => ({ status: 200 }));
    const path = join(dir, "p.xlsx");
    writeFileSync(path, "planilla de prueba");
    let progress = 0;

    await createNodePutFile()({
      url: r2.url,
      headers: { "content-type": "application/x", "x-amz-checksum-sha256": "abc=" },
      file: { path, size: 18 },
      onProgress: (bytes) => {
        progress += bytes;
      },
    });

    const [put] = r2.received;
    expect(put?.method).toBe("PUT");
    expect(put?.headers).toMatchObject({
      "content-length": "18",
      "content-type": "application/x",
      "x-amz-checksum-sha256": "abc=",
    });
    expect(put?.body.toString()).toBe("planilla de prueba");
    expect(progress).toBe(18);
  });

  it("un error de R2 sale como UploadError con su status y su código S3", async () => {
    const r2 = await fakeR2(() => ({
      status: 400,
      body: "<Error><Code>BadDigest</Code><Message>no calza</Message></Error>",
    }));
    const path = join(dir, "p.xlsx");
    writeFileSync(path, "x");

    const error = await createNodePutFile()({
      url: r2.url,
      headers: {},
      file: { path, size: 1 },
      onProgress: () => {},
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UploadError);
    expect(error).toMatchObject({ status: 400, s3Code: "BadDigest" });
  });
});

describe("uploadAll", () => {
  const target = (url: string, name = "p.xlsx") => ({
    kind: "xlsx" as const,
    name,
    url,
    headers: {},
  });

  it("un 5xx se reintenta con espera (1 s, 2 s) y el avance no cuenta dos veces", async () => {
    const r2 = await fakeR2((attempt) => ({ status: attempt < 3 ? 503 : 200 }));
    const path = join(dir, "p.xlsx");
    writeFileSync(path, "1234567890");
    const sleeps: number[] = [];
    const seen: number[] = [];

    await uploadAll([target(r2.url)], new Map([["xlsx:p.xlsx", { path, size: 10 }]]), {
      putFile: createNodePutFile(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onProgress: (progress) => seen.push(progress.sentBytes),
    });

    expect(r2.received).toHaveLength(3);
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(Math.max(...seen)).toBe(10);
  });

  it("un 400 (otro contenido) no se reintenta: CliError que dice que el archivo cambió, sin la URL", async () => {
    const r2 = await fakeR2(() => ({ status: 400, body: "<Error><Code>BadDigest</Code></Error>" }));
    const path = join(dir, "p.xlsx");
    writeFileSync(path, "x");

    const error = await uploadAll([target(r2.url)], new Map([["xlsx:p.xlsx", { path, size: 1 }]]), {
      putFile: createNodePutFile(),
      sleep: async () => {},
    }).catch((caught: unknown) => caught);

    expect(r2.received).toHaveLength(1);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: "IMPORT_UPLOAD_FAILED" });
    expect(String((error as Error).message)).toContain("el archivo cambió mientras se subía");
    expect(String((error as Error).message)).not.toContain("X-Amz-Signature");
  });
});

describe("buildImportManifest", () => {
  it("una carpeta: rutas con /, sha256 de cada archivo, sin ocultos ni __MACOSX", async () => {
    writeFileSync(join(dir, "p.xlsx"), "planilla");
    mkdirSync(join(dir, "medios", "P001"), { recursive: true });
    mkdirSync(join(dir, "medios", "__MACOSX"));
    writeFileSync(join(dir, "medios", "P001", "b.jpg"), "bbb");
    writeFileSync(join(dir, "medios", "P001", "a.jpg"), "aa");
    writeFileSync(join(dir, "medios", "P001", ".oculto"), "x");
    writeFileSync(join(dir, "medios", "__MACOSX", "basura"), "x");

    const manifest = await buildImportManifest(join(dir, "p.xlsx"), {
      kind: "dir",
      path: join(dir, "medios"),
    });

    expect(manifest.request).toEqual({
      xlsx: { name: "p.xlsx", size: 8, sha256: sha256("planilla") },
      media: {
        kind: "folder",
        name: "medios",
        files: [
          { path: "P001/a.jpg", size: 2, sha256: sha256("aa") },
          { path: "P001/b.jpg", size: 3, sha256: sha256("bbb") },
        ],
      },
    });
    expect([...manifest.files.keys()]).toEqual([
      "xlsx:p.xlsx",
      "file:P001/a.jpg",
      "file:P001/b.jpg",
    ]);
  });

  it("una carpeta con un archivo que se llama como la planilla no la pisa", async () => {
    writeFileSync(join(dir, "p.xlsx"), "planilla");
    mkdirSync(join(dir, "medios"));
    writeFileSync(join(dir, "medios", "p.xlsx"), "otra cosa");

    const manifest = await buildImportManifest(join(dir, "p.xlsx"), {
      kind: "dir",
      path: join(dir, "medios"),
    });

    expect(manifest.files.get("xlsx:p.xlsx")?.path).toBe(join(dir, "p.xlsx"));
    expect(manifest.files.get("file:p.xlsx")?.path).toBe(join(dir, "medios", "p.xlsx"));
  });

  it("un zip va con su tamaño, sin sha256", async () => {
    writeFileSync(join(dir, "p.xlsx"), "planilla");
    writeFileSync(join(dir, "medios.zip"), "zip");

    const manifest = await buildImportManifest(join(dir, "p.xlsx"), {
      kind: "zip",
      path: join(dir, "medios.zip"),
    });

    expect(manifest.request.media).toEqual({ kind: "zip", name: "medios.zip", size: 3 });
  });

  it("más de 500 archivos se avisa antes de calcular nada", async () => {
    writeFileSync(join(dir, "p.xlsx"), "planilla");
    mkdirSync(join(dir, "medios"));
    for (let i = 0; i <= 500; i += 1) writeFileSync(join(dir, "medios", `${i}.jpg`), "x");

    await expect(
      buildImportManifest(join(dir, "p.xlsx"), { kind: "dir", path: join(dir, "medios") }),
    ).rejects.toMatchObject({ code: "IMPORT_UPLOAD_INVALID" });
  });
});
