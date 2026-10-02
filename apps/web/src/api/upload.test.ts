// En Node (sin jsdom): aquí `FormData` y `File` son los de Node, así que la subida multipart que
// arma el cliente del panel llega tal cual a la API en proceso. Los tests de componentes no pueden
// hacerlo (el arnés la reenvía a `/imports/local`).
import { createApp, localAccess } from "@agentsales/api";
import { importRunResponseSchema } from "@agentsales/api/contracts";
import { fakeUploads, testDeps } from "@agentsales/api/testing";
import { describe, expect, it } from "vitest";
import { createApiClient, unwrap } from "./client.js";

function setup() {
  const uploads = fakeUploads();
  const app = createApp(testDeps({ access: localAccess(8787, 5173), uploads }));
  const client = createApiClient("/api", {
    fetch: async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        "http://localhost:5173",
      );
      const headers = new Headers(init?.headers);
      // El navegador manda `Origin` en un POST; sin él, `csrf()` rechaza el multipart.
      headers.set("origin", "http://localhost:5173");
      return app.request(`http://localhost:5173${url.pathname.replace(/^\/api/, "")}`, {
        ...init,
        headers,
      });
    },
  });
  return { client, uploads };
}

describe("subida del panel (POST /imports) contra la API real", () => {
  it("manda el Excel, el zip, el corredor y dryRun como los arma el cliente → 202", async () => {
    const { client, uploads } = setup();
    const xlsx = new File([new Uint8Array([1, 2, 3])], "propiedades.xlsx");
    const zip = new File([new Uint8Array([4, 5])], "medios.zip");

    const { importRun } = await unwrap(
      client.imports.$post({ form: { file: xlsx, media: zip, broker: "marca", dryRun: "true" } }),
      importRunResponseSchema,
    );

    expect(importRun).toMatchObject({
      status: "queued",
      dryRun: true,
      input: { xlsxFile: "propiedades.xlsx", mediaFile: "medios.zip", broker: "marca" },
    });
    const saved = uploads.files.get(importRun.id);
    expect(saved?.get("propiedades.xlsx")).toEqual(new Uint8Array([1, 2, 3]));
    expect(saved?.get("medios.zip")).toEqual(new Uint8Array([4, 5]));
  });

  it("sin zip ni corredor, la API los toma como no enviados", async () => {
    const { client } = setup();

    const { importRun } = await unwrap(
      client.imports.$post({
        form: { file: new File(["x"], "propiedades.xlsx"), dryRun: "false" },
      }),
      importRunResponseSchema,
    );

    expect(importRun.dryRun).toBe(false);
    expect(importRun.input).toMatchObject({ mediaFile: null, broker: null });
  });
});

describe("timeout de las subidas", () => {
  /** Responde después de `delayMs`, salvo que se aborte antes. */
  const slowFetch = (delayMs: number) => (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ status: "ok" })), delayMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal?.reason);
      });
    });

  it("una subida (FormData) usa su propio tope, más largo que el de una consulta", async () => {
    const client = createApiClient("/api", {
      fetch: slowFetch(60),
      timeoutMs: 10,
      uploadTimeoutMs: 1_000,
    });

    const response = await client.imports.$post({
      form: { file: new File(["x"], "propiedades.xlsx") },
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

  it("una subida que vence su tope sugiere revisar Cargas anteriores antes de reintentar", async () => {
    const client = createApiClient("/api", {
      fetch: slowFetch(1_000),
      uploadTimeoutMs: 20,
    });

    await expect(
      client.imports.$post({ form: { file: new File(["x"], "propiedades.xlsx") } }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      message: expect.stringContaining('revisa "Cargas anteriores" antes de reintentar'),
    });
  });
});
