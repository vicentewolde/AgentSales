import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createR2Storage } from "./r2-storage.js";

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
