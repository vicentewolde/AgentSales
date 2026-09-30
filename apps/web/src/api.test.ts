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

function stubFetch(response: () => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return response();
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

  it("un 502 del proxy (API apagada) es ApiUnavailableError", async () => {
    stubFetch(() => new Response("Bad Gateway", { status: 502 }));

    await expect(fetchHealth()).rejects.toMatchObject({
      name: "ApiUnavailableError",
      message: "La API no responde (HTTP 502)",
    });
  });

  it("una respuesta con otra forma se rechaza", async () => {
    stubFetch(() => Response.json({ hola: "mundo" }));

    await expect(fetchHealth()).rejects.toThrow(/Respuesta inesperada/);
  });

  it("un fallo de red es ApiUnavailableError", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));

    await expect(fetchHealth()).rejects.toMatchObject({ message: "La API no responde" });
  });
});
