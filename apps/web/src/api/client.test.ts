import { healthReportSchema } from "@agentsales/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, unwrap } from "./client.js";

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

const health = () => unwrap(createApiClient().health.$get(), healthReportSchema);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createApiClient + unwrap", () => {
  it("llama a /api/... a través del proxy y valida la respuesta", async () => {
    const calls = stubFetch(() => Response.json(healthy));

    expect(await health()).toEqual(healthy);
    expect(calls[0]).toMatch(/\/api\/health$/);
  });

  it("un 502 sin JSON del proxy (API apagada) es UNREACHABLE", async () => {
    stubFetch(() => new Response("Bad Gateway", { status: 502 }));

    await expect(health()).rejects.toMatchObject({
      name: "ApiError",
      code: "UNREACHABLE",
      status: 502,
      message: "La API no responde (HTTP 502)",
    });
  });

  it("un 4xx sin JSON informa el status", async () => {
    stubFetch(() => new Response("nope", { status: 418 }));

    await expect(health()).rejects.toMatchObject({ code: undefined, status: 418 });
  });

  it("un error de la API se muestra como CODE: mensaje, con su status", async () => {
    stubFetch(() =>
      Response.json(
        { error: { code: "HOST_NOT_ALLOWED", message: "Host no permitido: x:1" } },
        { status: 403 },
      ),
    );

    await expect(health()).rejects.toMatchObject({
      code: "HOST_NOT_ALLOWED",
      status: 403,
      message: "HOST_NOT_ALLOWED: Host no permitido: x:1",
    });
  });

  it.each([
    ["otro JSON", () => Response.json({ hola: "mundo" })],
    ["un 200 sin JSON", () => new Response("<html></html>", { status: 200 })],
  ])("rechaza %s", async (_label, response) => {
    stubFetch(response);

    await expect(health()).rejects.toMatchObject({ code: "UNEXPECTED_RESPONSE" });
  });

  it("un fallo de red es UNREACHABLE", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));

    await expect(health()).rejects.toMatchObject({
      code: "UNREACHABLE",
      message: "La API no responde",
    });
  });

  it("corta por timeout", async () => {
    stubFetch(
      (init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );

    await expect(
      unwrap(createApiClient("/api", { timeoutMs: 20 }).health.$get(), healthReportSchema),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("una cancelación (al desmontar) no se convierte en error de la API", async () => {
    stubFetch(
      (init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const controller = new AbortController();

    const pending = createApiClient().health.$get(undefined, {
      init: { signal: controller.signal },
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("un corte por timeout mientras llega el cuerpo es TIMEOUT, no otra forma", async () => {
    const response = {
      ok: true,
      status: 200,
      json: async () => {
        throw new DOMException("se acabó el tiempo", "TimeoutError");
      },
    };

    await expect(unwrap(response, healthReportSchema)).rejects.toMatchObject({
      code: "TIMEOUT",
      status: 200,
    });
  });
});

describe("createApiClient · Content-Type", () => {
  it("un pedido que cambia algo sin cuerpo va como JSON; una consulta y una subida no se tocan", async () => {
    const seen: Headers[] = [];
    const client = createApiClient("/api", {
      fetch: async (_input, init) => {
        seen.push(new Headers(init?.headers));
        return new Response("{}", { headers: { "content-type": "application/json" } });
      },
    });
    const id = "7f1c2a4e-9b3d-4f6a-8c2e-1d5b9a7e3f10";

    await client.accounts[":id"].disconnect.$post({ param: { id } });
    await client.accounts.$get();
    await client.imports.$post({ form: { file: new File(["x"], "a.xlsx") } });

    const [disconnect, list, upload] = seen;
    expect(disconnect?.get("content-type")).toBe("application/json");
    expect(list?.get("content-type")).toBeNull();
    expect(upload?.get("content-type") ?? "").not.toContain("application/json");
    // El panel no se identifica como la CLI: el actor de la bitácora queda `operator`.
    expect(disconnect?.get("x-agentsales-client")).toBeNull();
  });
});
