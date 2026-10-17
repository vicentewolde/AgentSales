import { isAppError } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { createAnthropicApiProvider } from "../src/anthropic-api.js";

// F7-T11 (spec F7 §4.7 y §4.14): el adaptador de la API de Anthropic con un `fetch` falso. Ningún
// test llama a la API de verdad (y la guardia de vitest.config.ts apunta el SDK a un puerto local).

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } } };
const request = { system: "reglas", prompt: "datos", jsonSchema: SCHEMA };

type Sent = {
  url: string;
  body: Record<string, unknown>;
  headers: Headers;
  signal: AbortSignal | null | undefined;
};

function provider(respond: (sent: Sent) => Response | Promise<Response>, timeoutMs = 2_000) {
  const sent: Sent[] = [];
  const llm = createAnthropicApiProvider({
    apiKey: "sk-ant-de-prueba",
    model: "claude-sonnet-5-5",
    timeoutMs,
    maxRetries: 0,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const call: Sent = {
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        headers: new Headers(init?.headers),
        signal: init?.signal,
      };
      sent.push(call);
      if (init?.signal?.aborted) throw init.signal.reason;
      return respond(call);
    }) as typeof fetch,
  });
  return { llm, sent };
}

const message = (overrides: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 1200,
    output_tokens: 300,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  ...overrides,
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_123", ...headers },
  });

const apiError = (status: number, type: string, message: string, details?: unknown) =>
  json({ type: "error", error: { type, message, ...(details ? { details } : {}) } }, status);

async function errorOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isAppError(error)) throw new Error(`se esperaba un AppError: ${String(error)}`);
  return error;
}

describe("anthropic-api", () => {
  it("pide salida estructurada con el modelo y devuelve el dato, el modelo y el uso", async () => {
    const { llm, sent } = provider(() => json(message()));
    const response = await llm.generateStructured(request);
    expect(response).toEqual({
      data: { ok: true },
      model: "claude-sonnet-5-5",
      usage: {
        inputTokens: 1200,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 300,
        requestId: "req_123",
      },
    });
    const [call] = sent;
    expect(call?.url).toMatch(/\/v1\/messages$/);
    expect(call?.headers.get("x-api-key")).toBe("sk-ant-de-prueba");
    expect(call?.body).toMatchObject({
      model: "claude-sonnet-5-5",
      system: "reglas",
      messages: [{ role: "user", content: "datos" }],
      output_config: { format: { type: "json_schema", schema: SCHEMA }, effort: "low" },
    });
    // Sin `thinking` (Sonnet 5.5 no acepta apagarlo) y sin tool use forzado.
    expect(call?.body).not.toHaveProperty("thinking");
    expect(call?.body).not.toHaveProperty("tool_choice");
  });

  it.each([
    [401, "authentication_error", "invalid x-api-key", "LLM_AUTH_REQUIRED", false],
    [403, "permission_error", "nope", "LLM_AUTH_REQUIRED", false],
    [402, "billing_error", "sin saldo", "LLM_ACCOUNT_LIMIT", false],
    [529, "overloaded_error", "Overloaded", "LLM_UNAVAILABLE", true],
    [500, "api_error", "boom", "LLM_UNAVAILABLE", true],
    [404, "not_found_error", "no existe el modelo", "LLM_REQUEST_REJECTED", false],
  ])("un %i (%s) es %s", async (status, type, text, code, retriable) => {
    const { llm } = provider(() => apiError(status, type, text));
    const error = await errorOf(llm.generateStructured(request));
    expect([error.code, error.retriable]).toEqual([code, retriable]);
    // Nunca la clave en el error.
    expect(JSON.stringify(error.details ?? {})).not.toContain("sk-ant");
  });

  it("un 429 con retry-after es LLM_RATE_LIMITED; el tope de gasto (429 o 400) es LLM_ACCOUNT_LIMIT", async () => {
    const limited = provider(() => apiError(429, "rate_limit_error", "slow down", undefined)).llm;
    const rate = await errorOf(
      provider(() =>
        json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429, {
          "retry-after": "12",
        }),
      ).llm.generateStructured(request),
    );
    expect(rate).toMatchObject({ code: "LLM_RATE_LIMITED", details: { retryAfter: "12" } });
    expect((await errorOf(limited.generateStructured(request))).code).toBe("LLM_RATE_LIMITED");

    const spend = await errorOf(
      provider(() =>
        apiError(429, "rate_limit_error", "monthly limit", {
          error_code: "enforced_spend_limit_reached",
        }),
      ).llm.generateStructured(request),
    );
    expect([spend.code, spend.retriable]).toEqual(["LLM_ACCOUNT_LIMIT", false]);
    const own = await errorOf(
      provider(() =>
        apiError(400, "invalid_request_error", "You have reached your specified API usage limits"),
      ).llm.generateStructured(request),
    );
    expect(own.code).toBe("LLM_ACCOUNT_LIMIT");
  });

  it("sin conexión es LLM_UNAVAILABLE (reintentable)", async () => {
    const { llm } = provider(() => {
      throw new TypeError("fetch failed");
    });
    const error = await errorOf(llm.generateStructured(request));
    expect([error.code, error.retriable]).toEqual(["LLM_UNAVAILABLE", true]);
  });

  it.each([
    ["refusal", "refusal"],
    ["max_tokens", "max_tokens"],
  ])(
    "stop_reason %s es LLM_OUTPUT_INVALID con el uso cobrado en el detalle",
    async (stop, reason) => {
      const { llm } = provider(() => json(message({ stop_reason: stop })));
      const error = await errorOf(llm.generateStructured(request));
      expect(error).toMatchObject({
        code: "LLM_OUTPUT_INVALID",
        details: { reason, model: "claude-sonnet-5-5", usage: { outputTokens: 300 } },
      });
    },
  );

  it("un texto que no es JSON es LLM_OUTPUT_INVALID", async () => {
    const { llm } = provider(() =>
      json(message({ content: [{ type: "text", text: "no es json" }] })),
    );
    expect((await errorOf(llm.generateStructured(request))).code).toBe("LLM_OUTPUT_INVALID");
  });

  it("cortar con la señal es LLM_ABORTED; pasar el tope es LLM_TIMEOUT", async () => {
    // Como el `fetch` real: no responde y se corta cuando se aborta su señal.
    const hang = (call: Sent) =>
      new Promise<Response>((_, reject) => {
        call.signal?.addEventListener("abort", () => reject(call.signal?.reason));
      });
    const controller = new AbortController();
    const aborted = provider(hang).llm.generateStructured({
      ...request,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    expect((await errorOf(aborted)).code).toBe("LLM_ABORTED");

    const slow = provider(hang, 50);
    const timeout = await errorOf(slow.llm.generateStructured(request));
    expect([timeout.code, timeout.retriable]).toEqual(["LLM_TIMEOUT", true]);
  });
});
