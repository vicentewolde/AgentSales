import { createHash } from "node:crypto";
import { AppError } from "@agentsales/core";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createR2Storage, readBody } from "./r2-storage.js";

const ORIGIN = "https://test-bucket.fake-account.r2.cloudflarestorage.com";

const options = {
  accountId: "fake-account",
  accessKeyId: "fake-access-key-id",
  secretAccessKey: "fake-secret-access-key",
  bucket: "test-bucket",
  signedUrlTtlSeconds: 3600,
};

// R2 simulado en memoria: ninguna petición sale a internet (onUnhandledFrame: "error").
const objects = new Map<string, { body: Uint8Array; contentType: string }>();
const keyOf = (request: Request) => decodeURIComponent(new URL(request.url).pathname.slice(1));

const server = setupServer(
  http.put(`${ORIGIN}/*`, async ({ request }) => {
    objects.set(keyOf(request), {
      body: new Uint8Array(await request.arrayBuffer()),
      contentType: request.headers.get("content-type") ?? "application/octet-stream",
    });
    return new HttpResponse(null, { status: 200, headers: { ETag: '"etag"' } });
  }),
  http.get(`${ORIGIN}/*`, ({ request }) => {
    const object = objects.get(keyOf(request));
    if (!object) {
      return new HttpResponse("<Error><Code>NoSuchKey</Code></Error>", {
        status: 404,
        headers: { "Content-Type": "application/xml" },
      });
    }
    return new HttpResponse(object.body, {
      status: 200,
      headers: { "Content-Type": object.contentType },
    });
  }),
  http.head(`${ORIGIN}/*`, ({ request }) => {
    const object = objects.get(keyOf(request));
    if (!object) {
      return new HttpResponse(null, { status: 404 });
    }
    return new HttpResponse(null, {
      status: 200,
      headers: {
        "Content-Type": object.contentType,
        "Content-Length": String(object.body.byteLength),
      },
    });
  }),
  http.delete(`${ORIGIN}/*`, ({ request }) => {
    objects.delete(keyOf(request));
    return new HttpResponse(null, { status: 204 });
  }),
);

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  server.resetHandlers();
  objects.clear();
});
afterAll(() => server.close());

describe("createR2Storage", () => {
  const storage = createR2Storage(options);
  const body = new TextEncoder().encode("hola R2");

  it("sube, lee, consulta metadatos y borra un objeto", async () => {
    await storage.put("brokers/b1/foto 1.jpg", body, "image/jpeg");

    expect(new TextDecoder().decode(await storage.get("brokers/b1/foto 1.jpg"))).toBe("hola R2");
    expect(await storage.head("brokers/b1/foto 1.jpg")).toEqual({
      size: body.byteLength,
      contentType: "image/jpeg",
    });

    await storage.delete("brokers/b1/foto 1.jpg");

    expect(await storage.head("brokers/b1/foto 1.jpg")).toBeNull();
  });

  it("head devuelve null si el objeto no existe", async () => {
    expect(await storage.head("no-existe.txt")).toBeNull();
  });

  it("get sobre un objeto inexistente lanza STORAGE_NOT_FOUND", async () => {
    await expect(storage.get("no-existe.txt")).rejects.toMatchObject({
      name: "AppError",
      code: "STORAGE_NOT_FOUND",
      retriable: false,
      details: { path: "no-existe.txt" },
    });
  });

  it("un 5xx es STORAGE_UNAVAILABLE y reintentable", async () => {
    server.use(http.head(`${ORIGIN}/*`, () => new HttpResponse(null, { status: 503 })));

    await expect(storage.head("x.txt")).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      retriable: true,
    });
  });

  it("un error de red es STORAGE_UNAVAILABLE y reintentable", async () => {
    server.use(http.put(`${ORIGIN}/*`, () => HttpResponse.error()));

    await expect(storage.put("x.txt", body, "text/plain")).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      retriable: true,
    });
  });

  it("un 403 (credenciales o permisos) es STORAGE_ERROR y no reintentable", async () => {
    server.use(
      http.delete(
        `${ORIGIN}/*`,
        () =>
          new HttpResponse("<Error><Code>AccessDenied</Code></Error>", {
            status: 403,
            headers: { "Content-Type": "application/xml" },
          }),
      ),
    );

    await expect(storage.delete("x.txt")).rejects.toMatchObject({
      code: "STORAGE_ERROR",
      retriable: false,
      details: { status: 403 },
    });
  });

  it("delete es idempotente: borrar algo que no existe no falla", async () => {
    await expect(storage.delete("no-existe.txt")).resolves.toBeUndefined();
  });

  it("put sobrescribe un objeto existente", async () => {
    await storage.put("a.txt", body, "text/plain");
    await storage.put("a.txt", new TextEncoder().encode("otro"), "text/plain");

    expect(new TextDecoder().decode(await storage.get("a.txt"))).toBe("otro");
  });
});

/** Un archivo en trozos, como lo entrega un `createReadStream`. */
async function* chunksOf(data: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < data.byteLength; offset += size) {
    yield data.subarray(offset, offset + size);
  }
}

describe("putStream", () => {
  const storage = createR2Storage(options);
  // 200 KB con un patrón reconocible, en trozos de 64 KB.
  const data = Uint8Array.from({ length: 200 * 1024 }, (_, index) => index % 251);

  it("sube el contenido exacto con su Content-Type y Content-Length", async () => {
    const seen: Record<string, string | null>[] = [];
    server.use(
      http.put(`${ORIGIN}/*`, async ({ request }) => {
        seen.push({
          contentLength: request.headers.get("content-length"),
          contentType: request.headers.get("content-type"),
          // Sin el checksum por defecto del SDK: nada de `aws-chunked` ni CRC32 al final.
          contentEncoding: request.headers.get("content-encoding"),
          trailer: request.headers.get("x-amz-trailer"),
        });
        objects.set(keyOf(request), {
          body: new Uint8Array(await request.arrayBuffer()),
          contentType: request.headers.get("content-type") ?? "",
        });
        return new HttpResponse(null, { status: 200, headers: { ETag: '"etag"' } });
      }),
    );

    await storage.putStream(
      "brokers/b1/listings/l1/original/video.mp4",
      chunksOf(data, 64 * 1024),
      {
        contentType: "video/mp4",
        contentLength: data.byteLength,
      },
    );

    expect(seen).toEqual([
      {
        contentLength: String(data.byteLength),
        contentType: "video/mp4",
        contentEncoding: null,
        trailer: null,
      },
    ]);
    expect(await storage.get("brokers/b1/listings/l1/original/video.mp4")).toEqual(data);
  });

  describe("con sha256 (F1-T07b)", () => {
    const hex = createHash("sha256").update(data).digest("hex");

    it("manda ChecksumSHA256 en base64, con Content-Length y sin aws-chunked ni trailer", async () => {
      const seen: Record<string, string | null>[] = [];
      server.use(
        http.put(`${ORIGIN}/*`, async ({ request }) => {
          seen.push({
            checksum: request.headers.get("x-amz-checksum-sha256"),
            algorithm: request.headers.get("x-amz-sdk-checksum-algorithm"),
            contentLength: request.headers.get("content-length"),
            contentEncoding: request.headers.get("content-encoding"),
            transferEncoding: request.headers.get("transfer-encoding"),
            trailer: request.headers.get("x-amz-trailer"),
          });
          objects.set(keyOf(request), {
            body: new Uint8Array(await request.arrayBuffer()),
            contentType: request.headers.get("content-type") ?? "",
          });
          return new HttpResponse(null, { status: 200, headers: { ETag: '"etag"' } });
        }),
      );

      await storage.putStream("x.mp4", chunksOf(data, 64 * 1024), {
        contentType: "video/mp4",
        contentLength: data.byteLength,
        sha256: hex,
      });

      expect(seen).toEqual([
        {
          checksum: Buffer.from(hex, "hex").toString("base64"),
          algorithm: null,
          contentLength: String(data.byteLength),
          contentEncoding: null,
          transferEncoding: null,
          trailer: null,
        },
      ]);
      expect(await storage.get("x.mp4")).toEqual(data);
    });

    it("un sha256 en mayúsculas se acepta y da el mismo ChecksumSHA256", async () => {
      const checksums: (string | null)[] = [];
      server.use(
        http.put(`${ORIGIN}/*`, async ({ request }) => {
          checksums.push(request.headers.get("x-amz-checksum-sha256"));
          await request.arrayBuffer();
          return new HttpResponse(null, { status: 200, headers: { ETag: '"etag"' } });
        }),
      );

      await storage.putStream("x.mp4", chunksOf(data, 64 * 1024), {
        contentType: "video/mp4",
        contentLength: data.byteLength,
        sha256: hex.toUpperCase(),
      });

      expect(checksums).toEqual([Buffer.from(hex, "hex").toString("base64")]);
    });

    it("con sha256, un largo distinto sigue siendo STORAGE_CONTENT_MISMATCH por el largo", async () => {
      await expect(
        storage.putStream("x.mp4", chunksOf(data, 64 * 1024), {
          contentType: "video/mp4",
          contentLength: data.byteLength + 1,
          sha256: hex,
        }),
      ).rejects.toMatchObject({
        code: "STORAGE_CONTENT_MISMATCH",
        details: { expected: data.byteLength + 1, received: data.byteLength },
      });
      expect(objects.has("x.mp4")).toBe(false);
    });

    it("un BadDigest de R2 es STORAGE_CONTENT_MISMATCH, no reintentable", async () => {
      server.use(
        http.put(`${ORIGIN}/*`, async ({ request }) => {
          await request.arrayBuffer();
          return new HttpResponse(
            "<Error><Code>BadDigest</Code><Message>Provided checksum does not match the uploaded content</Message></Error>",
            { status: 400, headers: { "Content-Type": "application/xml" } },
          );
        }),
      );

      await expect(
        storage.putStream("x.mp4", chunksOf(data, 64 * 1024), {
          contentType: "video/mp4",
          contentLength: data.byteLength,
          sha256: hex,
        }),
      ).rejects.toMatchObject({ code: "STORAGE_CONTENT_MISMATCH", retriable: false });
    });

    it.each(["abc", "z".repeat(64), Buffer.from(hex, "hex").toString("base64")])(
      "un sha256 que no es hexadecimal de 64 caracteres (%s) es STORAGE_ERROR, sin subir nada",
      async (sha256) => {
        await expect(
          storage.putStream("x.mp4", chunksOf(data, 64 * 1024), {
            contentType: "video/mp4",
            contentLength: data.byteLength,
            sha256,
          }),
        ).rejects.toMatchObject({ code: "STORAGE_ERROR", retriable: false });
        expect(objects.has("x.mp4")).toBe(false);
      },
    );
  });

  // Comportamiento, no configuración: el SDK ya no reintenta un cuerpo que es stream, así que este
  // test pasa con o sin `maxAttempts: 1` (que es defensivo). Lo que fija es que hay un solo intento.
  it("un 5xx es STORAGE_UNAVAILABLE con un solo intento", async () => {
    let attempts = 0;
    server.use(
      http.put(`${ORIGIN}/*`, () => {
        attempts++;
        return new HttpResponse(null, { status: 503 });
      }),
    );

    await expect(
      storage.putStream("x.mp4", chunksOf(data, 64 * 1024), {
        contentType: "video/mp4",
        contentLength: data.byteLength,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", retriable: true });
    expect(attempts).toBe(1);
  });

  it("un corte de red es STORAGE_UNAVAILABLE y reintentable", async () => {
    server.use(http.put(`${ORIGIN}/*`, () => HttpResponse.error()));

    await expect(
      storage.putStream("x.mp4", chunksOf(data, 64 * 1024), {
        contentType: "video/mp4",
        contentLength: data.byteLength,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", retriable: true });
  });

  it.each([
    ["más", data.byteLength - 1],
    ["menos", data.byteLength + 1],
  ])(
    "un stream con %s bytes que contentLength es STORAGE_CONTENT_MISMATCH y no guarda nada",
    async (_, length) => {
      await expect(
        storage.putStream("x.mp4", chunksOf(data, 64 * 1024), {
          contentType: "video/mp4",
          contentLength: length,
        }),
      ).rejects.toMatchObject({
        code: "STORAGE_CONTENT_MISMATCH",
        retriable: false,
        details: { path: "x.mp4", expected: length, received: data.byteLength },
      });
      expect(objects.has("x.mp4")).toBe(false);
    },
  );

  it("un AppError del lector de origen pasa tal cual, con su código y si es reintentable", async () => {
    async function* vanished(): AsyncGenerator<Uint8Array> {
      yield data.subarray(0, 1024);
      throw new AppError("MEDIA_FILE_UNAVAILABLE", "El archivo ya no está", { retriable: true });
    }
    await expect(
      storage.putStream("x.mp4", vanished(), {
        contentType: "video/mp4",
        contentLength: data.byteLength,
      }),
    ).rejects.toMatchObject({ code: "MEDIA_FILE_UNAVAILABLE", retriable: true });
  });

  it.each([Number.NaN, -1, 1.5])(
    "un contentLength inválido (%s) es STORAGE_ERROR, sin subir nada",
    async (length) => {
      let requests = 0;
      server.use(
        http.put(`${ORIGIN}/*`, () => {
          requests++;
          return new HttpResponse(null, { status: 200 });
        }),
      );
      await expect(
        storage.putStream("x.mp4", chunksOf(data, 64 * 1024), {
          contentType: "video/mp4",
          contentLength: length,
        }),
      ).rejects.toMatchObject({ code: "STORAGE_ERROR", retriable: false });
      expect(requests).toBe(0);
    },
  );

  it("los demás métodos siguen reintentando (cliente aparte para los streams)", async () => {
    let attempts = 0;
    server.use(
      http.head(`${ORIGIN}/*`, () => {
        attempts++;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    await expect(storage.head("x.txt")).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(attempts).toBeGreaterThan(1);
  });
});

describe("getStream (F2-T03)", () => {
  const storage = createR2Storage(options);

  async function readAll(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return new Uint8Array(Buffer.concat(chunks));
  }

  it("lee el objeto completo, sin cambiar un byte", async () => {
    // msw entrega el cuerpo en un solo trozo; contra R2 llega en varios (`storage:check`).
    const data = Uint8Array.from({ length: 3 * 1024 * 1024 }, (_, index) => (index * 7) % 256);
    objects.set("videos/largo.mp4", { body: data, contentType: "video/mp4" });

    const read = await readAll(await storage.getStream("videos/largo.mp4"));
    expect(Buffer.from(read).equals(Buffer.from(data))).toBe(true);
  });

  it("un objeto vacío es un iterable vacío", async () => {
    objects.set("vacio.bin", { body: new Uint8Array(), contentType: "application/octet-stream" });
    expect((await readAll(await storage.getStream("vacio.bin"))).byteLength).toBe(0);
  });

  it("un objeto inexistente es STORAGE_NOT_FOUND al pedirlo", async () => {
    await expect(storage.getStream("no-existe.mp4")).rejects.toMatchObject({
      code: "STORAGE_NOT_FOUND",
      retriable: false,
      details: { path: "no-existe.mp4" },
    });
  });

  it("un 5xx es STORAGE_UNAVAILABLE y reintentable", async () => {
    server.use(http.get(`${ORIGIN}/*`, () => new HttpResponse(null, { status: 503 })));
    await expect(storage.getStream("x.mp4")).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      retriable: true,
    });
  });

  it("un corte de la conexión es STORAGE_UNAVAILABLE, al pedir o al leer", async () => {
    server.use(
      http.get(`${ORIGIN}/*`, () => {
        let sent = false;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(new Uint8Array(64 * 1024).fill(1));
              return;
            }
            controller.error(new Error("socket hang up"));
          },
        });
        return new HttpResponse(body, {
          status: 200,
          headers: { "Content-Type": "video/mp4", "Content-Length": String(1024 * 1024) },
        });
      }),
    );
    // msw adelanta el corte a la respuesta; contra R2 puede llegar a mitad de la lectura.
    await expect(
      (async () => readAll(await storage.getStream("cortado.mp4")))(),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", retriable: true });
  });

  it("un error a mitad de la lectura sale como AppError, no como el error del socket", async () => {
    async function* cut(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1, 2, 3]);
      throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    }
    const received: number[] = [];
    await expect(
      (async () => {
        for await (const chunk of readBody(cut(), "videos/cortado.mp4")) {
          received.push(...chunk);
        }
      })(),
    ).rejects.toMatchObject({
      name: "AppError",
      code: "STORAGE_UNAVAILABLE",
      retriable: true,
      details: { path: "videos/cortado.mp4" },
    });
    expect(received).toEqual([1, 2, 3]);
  });

  it("dejar de leer a mitad no deja errores colgando", async () => {
    const data = new Uint8Array(2 * 1024 * 1024).fill(9);
    objects.set("parcial.mp4", { body: data, contentType: "video/mp4" });
    const stream = await storage.getStream("parcial.mp4");
    for await (const chunk of stream) {
      expect(chunk.byteLength).toBeGreaterThan(0);
      break;
    }
    // Después de cortar se puede volver a pedir y leer completo.
    expect((await readAll(await storage.getStream("parcial.mp4"))).byteLength).toBe(
      data.byteLength,
    );
  });
});

describe("signedReadUrl", () => {
  const storage = createR2Storage(options);

  it("usa el TTL configurado y firma el objeto del bucket en R2 (sin red)", async () => {
    const url = new URL(await storage.signedReadUrl("brokers/b1/foto.jpg"));

    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe("/brokers/b1/foto.jpg");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("respeta un TTL explícito y el TTL configurado distinto", async () => {
    const custom = createR2Storage({ ...options, signedUrlTtlSeconds: 900 });

    expect(
      new URL(await storage.signedReadUrl("a.jpg", 60)).searchParams.get("X-Amz-Expires"),
    ).toBe("60");
    expect(new URL(await custom.signedReadUrl("a.jpg")).searchParams.get("X-Amz-Expires")).toBe(
      "900",
    );
  });

  it("no expone el secreto en la URL", async () => {
    const url = await storage.signedReadUrl("a.jpg");

    expect(url).not.toContain(options.secretAccessKey);
  });
});
