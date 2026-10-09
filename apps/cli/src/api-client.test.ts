import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiCallError,
  apiUrl,
  createApiClient,
  createHealthFetcher,
  unwrap,
} from "./api-client.js";

const healthy = {
  status: "ok",
  publishMode: "dry-run",
  version: "0.0.1",
  checks: {
    db: { ok: true, latencyMs: 60 },
    storage: { ok: true, latencyMs: 200 },
    queue: { ok: true, latencyMs: 65 },
  },
};

let server: Server | undefined;

/** Servidor HTTP local en un puerto libre (solo 127.0.0.1; sin red externa). */
async function serve(handler: (res: import("node:http").ServerResponse) => void): Promise<number> {
  const created = createServer((_req, res) => handler(res));
  server = created;
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  return (created.address() as AddressInfo).port;
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("createHealthFetcher", () => {
  it("apunta a la API en IPv4 local", () => {
    expect(apiUrl(8787)).toBe("http://127.0.0.1:8787");
  });

  it("devuelve el informe de /health validado", async () => {
    const port = await serve((res) => {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(healthy));
    });

    expect(await createHealthFetcher(createApiClient(port))()).toEqual(healthy);
  });

  it("un error de la API se muestra como CODE: mensaje, con el status", async () => {
    const port = await serve((res) => {
      res
        .writeHead(403, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: { code: "HOST_NOT_ALLOWED", message: "Host no permitido" } }));
    });

    const error = await createHealthFetcher(createApiClient(port))().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiCallError);
    expect(error).toMatchObject({
      code: "HOST_NOT_ALLOWED",
      message: "HOST_NOT_ALLOWED: Host no permitido",
      status: 403,
    });
  });

  it.each([
    ["HTML", "text/html", "<html>otro servicio</html>"],
    ["otro JSON", "application/json", JSON.stringify({ hola: "mundo" })],
  ])("rechaza una respuesta 200 con %s", async (_label, type, body) => {
    const port = await serve((res) => {
      res.writeHead(200, { "Content-Type": type }).end(body);
    });

    await expect(createHealthFetcher(createApiClient(port))()).rejects.toMatchObject({
      code: "UNEXPECTED_RESPONSE",
    });
  });

  it("corta por timeout si la API no responde", async () => {
    const port = await serve(() => {
      // nunca responde
    });

    await expect(
      createHealthFetcher(createApiClient(port, { timeoutMs: 100 }))(),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "sin respuesta en 100 ms",
    });
  });

  it("informa ECONNREFUSED si nadie escucha", async () => {
    const port = await serve(() => {});
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    await expect(
      createHealthFetcher(createApiClient(port, { timeoutMs: 2_000 }))(),
    ).rejects.toMatchObject({ code: "ECONNREFUSED", status: undefined });
  });
});

describe("unwrap", () => {
  const response = (status: number, body: unknown) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  const schema = z.object({ hola: z.string() });

  it("devuelve el cuerpo validado", async () => {
    expect(await unwrap(response(200, { hola: "mundo" }), schema)).toEqual({ hola: "mundo" });
  });

  it("un error sin ErrorBody informa el status", async () => {
    await expect(unwrap(response(502, "<html>proxy</html>"), schema)).rejects.toMatchObject({
      message: "la API respondió 502",
      code: undefined,
      status: 502,
    });
  });

  it("PORTAL_NOT_READY trae la lista de lo que falta; los demás errores, sin lista", async () => {
    const issue = { code: "PORTAL_WHATSAPP_MISSING", field: null, message: "Falta el WhatsApp" };
    const notReady = response(409, {
      error: { code: "PORTAL_NOT_READY", message: "Falta información", issues: [issue] },
    });
    await expect(unwrap(notReady, schema)).rejects.toMatchObject({
      code: "PORTAL_NOT_READY",
      apiMessage: "Falta información",
      issues: [issue],
    });
    const other = response(409, { error: { code: "INVALID_TRANSITION", message: "no" } });
    await expect(unwrap(other, schema)).rejects.toMatchObject({ issues: undefined });
  });

  it("un corte por timeout mientras llega el cuerpo es TIMEOUT", async () => {
    const cut = {
      ok: true,
      status: 200,
      json: async () => {
        throw new DOMException("se acabó el tiempo", "TimeoutError");
      },
    };
    await expect(unwrap(cut, schema)).rejects.toMatchObject({ code: "TIMEOUT", status: 200 });
  });

  it("una respuesta exitosa con otra forma es UNEXPECTED_RESPONSE", async () => {
    await expect(unwrap(response(200, { otra: 1 }), schema)).rejects.toMatchObject({
      code: "UNEXPECTED_RESPONSE",
    });
  });
});

describe("createApiClient · cabeceras", () => {
  it("se identifica como la CLI y manda JSON en un POST sin cuerpo, sin pisar el de un formulario", async () => {
    const seen: { method: string; path: string; headers: Headers }[] = [];
    const client = createApiClient(8787, {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        seen.push({
          method: init?.method ?? "GET",
          path: url.pathname,
          headers: new Headers(init?.headers),
        });
        return new Response("{}", { headers: { "content-type": "application/json" } });
      },
    });
    const id = "7f1c2a4e-9b3d-4f6a-8c2e-1d5b9a7e3f10";

    await client.publications[":id"].cancel.$post({ param: { id } });
    await client.health.$get();
    await client.imports.$post({ form: { broker: "marca", file: new File(["x"], "a.xlsx") } });

    const [cancel, health, upload] = seen;
    expect(cancel?.headers.get("x-agentsales-client")).toBe("cli");
    expect(cancel?.headers.get("content-type")).toBe("application/json");
    expect(health?.headers.get("x-agentsales-client")).toBe("cli");
    expect(health?.headers.get("content-type")).toBeNull();
    expect(upload?.headers.get("content-type") ?? "").not.toContain("application/json");
  });
});
