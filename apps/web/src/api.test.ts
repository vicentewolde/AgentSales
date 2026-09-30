import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchHealth } from "./api.js";

const healthy = {
  status: "ok",
  publishMode: "dry-run",
  version: "0.0.1",
  checks: {
    db: { ok: true, latencyMs: 60 },
    storage: { ok: true, latencyMs: 210 },
    queue: { ok: true, latencyMs: 65 },
  },
};

function stubFetch(response: (init?: RequestInit) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return response(init);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchHealth", () => {
  it("llama a /api/health a través del proxy y valida la respuesta", async () => {
    const calls = stubFetch(() => Response.json(healthy));

    expect(await fetchHealth()).toEqual(healthy);
    expect(calls[0]).toMatch(/\/api\/health$/);
  });

  it("un 502 sin JSON del proxy (API apagada) es UNREACHABLE", async () => {
    stubFetch(() => new Response("Bad Gateway", { status: 502 }));

    await expect(fetchHealth()).rejects.toMatchObject({
      name: "ApiError",
      code: "UNREACHABLE",
      message: "La API no responde (HTTP 502)",
    });
  });

  it("un error de la API se muestra como CODE: mensaje", async () => {
    stubFetch(() =>
      Response.json(
        { error: { code: "HOST_NOT_ALLOWED", message: "Host no permitido: x:1" } },
        { status: 403 },
      ),
    );

    await expect(fetchHealth()).rejects.toMatchObject({
      code: "HOST_NOT_ALLOWED",
      message: "HOST_NOT_ALLOWED: Host no permitido: x:1",
    });
  });

  it.each([
    ["otro JSON", () => Response.json({ hola: "mundo" })],
    ["un 200 sin JSON", () => new Response("<html></html>", { status: 200 })],
  ])("rechaza %s", async (_label, response) => {
    stubFetch(response);

    await expect(fetchHealth()).rejects.toMatchObject({ code: "UNEXPECTED_RESPONSE" });
  });

  it("un fallo de red es UNREACHABLE", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));

    await expect(fetchHealth()).rejects.toMatchObject({ message: "La API no responde" });
  });

  it("pasa una señal a fetch (cancelación y timeout)", async () => {
    let received: AbortSignal | null | undefined;
    stubFetch((init) => {
      received = init?.signal;
      return Response.json(healthy);
    });

    await fetchHealth(new AbortController().signal);

    expect(received).toBeInstanceOf(AbortSignal);
  });
});
