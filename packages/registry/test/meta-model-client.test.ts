import { describe, expect, it } from "vitest";
import {
  MetaApiError,
  MetaModelClient,
  type SpendBudget,
} from "../src/adapters/meta-model-client.js";

const REQUEST = {
  model: "muse-spark-1.3",
  instructions: "Traduce",
  input: "hola",
  maxOutputTokens: 100,
  label: "prueba",
};

function budget() {
  const log: string[] = [];
  const b: SpendBudget = {
    reserve: (usd, label) => {
      if (usd > 1) throw new Error("tope");
      log.push(`reserve:${label}`);
    },
    record: (usd, label) => log.push(`record:${label}:${usd.toFixed(6)}`),
  };
  return { b, log };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("MetaModelClient", () => {
  it("manda el pedido con la clave en el encabezado, anota el gasto y devuelve el texto", async () => {
    const { b, log } = budget();
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const client = new MetaModelClient({
      apiKey: "clave-de-prueba",
      budget: b,
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return ok({ output_text: "hello", usage: { input_tokens: 1000, output_tokens: 100 } });
      },
    });
    const r = await client.respond(REQUEST);
    expect(r.text).toBe("hello");
    expect(calls[0]?.url).toBe("https://api.meta.ai/v1/responses");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer clave-de-prueba");
    expect(calls[0]?.body).toMatchObject({ model: "muse-spark-1.3", store: false });
    expect(log).toEqual(["reserve:prueba", "record:prueba:0.001675"]);
  });

  it("reintenta un 429 y un 5xx, pero no un 400", async () => {
    const { b } = budget();
    let n = 0;
    const client = new MetaModelClient({
      apiKey: "k",
      budget: b,
      sleep: async () => {},
      fetch: async () => {
        n++;
        if (n === 1) return new Response("lento", { status: 429 });
        if (n === 2) return new Response("caído", { status: 503 });
        return ok({ output: [{ content: [{ type: "output_text", text: "listo" }] }] });
      },
    });
    expect((await client.respond(REQUEST)).text).toBe("listo");
    expect(n).toBe(3);

    const bad = new MetaModelClient({
      apiKey: "k",
      budget: b,
      sleep: async () => {},
      fetch: async () => new Response("mal pedido", { status: 400 }),
    });
    await expect(bad.respond(REQUEST)).rejects.toBeInstanceOf(MetaApiError);
  });

  it("una respuesta vacía o incompleta falla en voz alta, y el tope corta antes de llamar", async () => {
    const { b } = budget();
    const empty = new MetaModelClient({
      apiKey: "k",
      budget: b,
      fetch: async () =>
        ok({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
    });
    await expect(empty.respond(REQUEST)).rejects.toThrow(/no devolvió texto/);

    let called = false;
    const capped = new MetaModelClient({
      apiKey: "k",
      budget: b,
      fetch: async () => {
        called = true;
        return ok({});
      },
    });
    await expect(capped.respond({ ...REQUEST, maxOutputTokens: 10_000_000 })).rejects.toThrow(
      "tope",
    );
    expect(called).toBe(false);
    expect(() => new MetaModelClient({ apiKey: "", budget: b })).toThrow();
  });
});
