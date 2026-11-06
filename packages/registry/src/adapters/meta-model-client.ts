import type { ModelClient, ModelRequest } from "../ports/model.js";

// Adaptador de la API de modelos de Meta (Responses API) detrás de `ModelClient` (ADR-0040).
// Precios de https://dev.meta.ai/docs/pricing-rate-limits (leídos el 2026-10-26), USD por 1M tokens.

export const DEFAULT_META_BASE_URL = "https://api.meta.ai/v1";

const TOKEN_PRICES: Record<string, { input: number; cachedInput: number; output: number }> = {
  "muse-spark-1.3": { input: 1.25, cachedInput: 0.15, output: 4.25 },
  "muse-spark-1.2": { input: 1.25, cachedInput: 0.15, output: 4.25 },
};

type Usage = {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
};

/** El tope de gasto lo pone quien arma el cliente (por corredor): se reserva antes y se anota después. */
export interface SpendBudget {
  /** Lanza si el peor caso (`maxUsd`) no cabe. */
  reserve(maxUsd: number, label: string): void;
  record(actualUsd: number, label: string): void;
}

export class MetaApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryable: boolean,
  ) {
    super(`Meta Model API ${status}: ${body.slice(0, 300)}`);
  }
}

export class IncompleteResponseError extends Error {}

export type MetaModelClientOptions = {
  apiKey: string;
  budget: SpendBudget;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
};

type ResponsesBody = {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  output_text?: string;
  usage?: Usage;
};

export function extractText(json: ResponsesBody): string {
  if (typeof json.output_text === "string") return json.output_text;
  const parts: string[] = [];
  for (const item of json.output ?? []) {
    for (const c of item.content ?? []) if (c.type === "output_text" && c.text) parts.push(c.text);
  }
  return parts.join("");
}

export function tokenCostUsd(model: string, usage: Usage): number {
  const p = TOKEN_PRICES[model] ?? TOKEN_PRICES["muse-spark-1.3"];
  if (p === undefined) return 0;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const fresh = Math.max(0, usage.input_tokens - cached);
  return (fresh * p.input + cached * p.cachedInput + usage.output_tokens * p.output) / 1_000_000;
}

const backoff = (attempt: number): number =>
  Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);

export class MetaModelClient implements ModelClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: MetaModelClientOptions) {
    if (opts.apiKey === "") throw new Error("Falta la clave de la API de modelos");
    this.baseUrl = opts.baseUrl ?? DEFAULT_META_BASE_URL;
    this.doFetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** 429 y 5xx se reintentan con espera (respetando Retry-After); un 4xx nunca. */
  private async send(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.doFetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (error) {
        if (attempt >= this.maxRetries) throw error;
        await this.sleep(backoff(attempt));
        continue;
      }
      if (res.ok) return res;
      const body = await res.text();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.maxRetries) {
        throw new MetaApiError(res.status, body, retryable);
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      await this.sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
    }
  }

  async respond(request: ModelRequest): Promise<{ text: string }> {
    const price = TOKEN_PRICES[request.model] ?? TOKEN_PRICES["muse-spark-1.3"];
    const estInput = request.estInputTokens ?? Math.ceil(request.input.length / 3);
    if (price !== undefined) {
      this.opts.budget.reserve(
        (estInput * price.input + request.maxOutputTokens * price.output) / 1_000_000,
        request.label,
      );
    }
    const body: Record<string, unknown> = {
      model: request.model,
      input: request.input,
      instructions: request.instructions,
      max_output_tokens: request.maxOutputTokens,
      store: false,
    };
    if (request.reasoningEffort) body.reasoning = { effort: request.reasoningEffort };
    if (request.jsonSchema) {
      body.text = {
        format: {
          type: "json_schema",
          name: request.jsonSchema.name,
          schema: request.jsonSchema.schema,
          strict: true,
        },
      };
    }
    const res = await this.send(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as ResponsesBody;
    const usage = json.usage ?? { input_tokens: estInput, output_tokens: request.maxOutputTokens };
    this.opts.budget.record(tokenCostUsd(request.model, usage), request.label);
    const text = extractText(json);
    if (json.status === "incomplete" || text.trim() === "") {
      throw new IncompleteResponseError(
        `El modelo no devolvió texto (${json.incomplete_details?.reason ?? "vacío"}); sube maxOutputTokens`,
      );
    }
    return { text };
  }
}
