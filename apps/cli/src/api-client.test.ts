import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ApiCallError, apiUrl, createHealthFetcher } from "./api-client.js";

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

    expect(await createHealthFetcher(port)()).toEqual(healthy);
  });

  it("un error de la API se muestra como CODE: mensaje", async () => {
    const port = await serve((res) => {
      res
        .writeHead(403, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: { code: "HOST_NOT_ALLOWED", message: "Host no permitido" } }));
    });

    const error = await createHealthFetcher(port)().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiCallError);
    expect(error).toMatchObject({
      code: "HOST_NOT_ALLOWED",
      message: "HOST_NOT_ALLOWED: Host no permitido",
    });
  });

  it.each([
    ["HTML", "text/html", "<html>otro servicio</html>"],
    ["otro JSON", "application/json", JSON.stringify({ hola: "mundo" })],
  ])("rechaza una respuesta 200 con %s", async (_label, type, body) => {
    const port = await serve((res) => {
      res.writeHead(200, { "Content-Type": type }).end(body);
    });

    await expect(createHealthFetcher(port)()).rejects.toMatchObject({
      code: "UNEXPECTED_RESPONSE",
    });
  });

  it("corta por timeout si la API no responde", async () => {
    const port = await serve(() => {
      // nunca responde
    });

    await expect(createHealthFetcher(port, 100)()).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "sin respuesta en 0 s",
    });
  });

  it("informa ECONNREFUSED si nadie escucha", async () => {
    const port = await serve(() => {});
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    await expect(createHealthFetcher(port, 2_000)()).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
  });
});
