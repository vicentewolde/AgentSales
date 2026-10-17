import { z } from "zod";
import { LLM_PROVIDERS, type LlmProvider } from "./enums.js";

// Lo gastado en IA (spec F7 §4.7): cada llamada se suma a la corrida en cuanto vuelve, también
// las que fallan después. El costo es una estimación con la tabla de precios de core.

/** El uso de una llamada al modelo, con su costo estimado. */
export const llmCallUsageSchema = z.object({
  provider: z.enum(LLM_PROVIDERS),
  model: z.string(),
  /** Entrada sin caché (la posterior al último punto de caché). */
  inputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  /** Fecha de la tabla de precios con que se estimó; `null` si no hay precio (el plan). */
  priceTable: z.string().nullable(),
  requestId: z.string().nullable(),
});
export type LlmCallUsage = z.infer<typeof llmCallUsageSchema>;

/** Lo acumulado en una corrida (`content_runs.llm_usage`). */
export const llmUsageSchema = z.object({
  calls: z.number().int().positive(),
  /** Proveedor y modelo de la última llamada. */
  provider: z.enum(LLM_PROVIDERS),
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  priceTable: z.string().nullable(),
  requestIds: z.array(z.string()),
});
export type LlmUsage = z.infer<typeof llmUsageSchema>;

/** Suma una llamada a lo acumulado (`null`: la primera). */
export function addLlmCall(usage: LlmUsage | null, call: LlmCallUsage): LlmUsage {
  return {
    calls: (usage?.calls ?? 0) + 1,
    provider: call.provider,
    model: call.model,
    inputTokens: (usage?.inputTokens ?? 0) + call.inputTokens,
    cacheCreationInputTokens:
      (usage?.cacheCreationInputTokens ?? 0) + call.cacheCreationInputTokens,
    cacheReadInputTokens: (usage?.cacheReadInputTokens ?? 0) + call.cacheReadInputTokens,
    outputTokens: (usage?.outputTokens ?? 0) + call.outputTokens,
    costUsd: (usage?.costUsd ?? 0) + call.costUsd,
    priceTable: call.priceTable ?? usage?.priceTable ?? null,
    requestIds:
      call.requestId === null
        ? [...(usage?.requestIds ?? [])]
        : [...(usage?.requestIds ?? []), call.requestId],
  };
}

/** Gasto de un corredor en un rango de fechas de creación de las corridas. */
export type BrokerLlmSpend = { brokerId: string; costUsd: number; runs: number };

/** Los tokens de una llamada, como los informa el proveedor (`LLMResponse.usage`). */
export type LlmTokenUsage = {
  /** Entrada sin caché (la posterior al último punto de caché). */
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  requestId: string | null;
};

/** Precio por millón de tokens, en dólares. */
type ModelPrice = {
  input: number;
  output: number;
  cacheRead: number;
  /** Haiku 5.5 cobra más si el prompt pasa de 100.000 tokens. */
  above?: { promptTokens: number; input: number; output: number };
};

/**
 * Tabla de precios de la API de Anthropic (spec F7 §4.14; docs/integraciones/anthropic-api.md
 * §11.2). Una **estimación**: manda la consola de Anthropic. Escribir en caché cuesta 1,25 veces la
 * entrada. Al cambiar un precio, se cambia `LLM_PRICE_TABLE`.
 */
export const LLM_PRICE_TABLE = "2026-10-16";
const LLM_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    above: { promptTokens: 100_000, input: 0.5, output: 2.5 },
  },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
};

/** El precio de un modelo; acepta un id con fecha o sufijo (`claude-sonnet-5-5-…`). */
function priceOf(model: string): ModelPrice | undefined {
  return (
    LLM_PRICES[model] ?? Object.entries(LLM_PRICES).find(([id]) => model.startsWith(`${id}-`))?.[1]
  );
}

/**
 * Una llamada con su costo estimado. Solo `anthropic-api` se cobra: el plan del operador
 * (`claude-cli`) y `fake` cuestan 0. Un modelo sin precio en la tabla cuesta 0 y lleva
 * `priceTable: null` (se ve en el registro).
 */
export function llmCallCost(
  provider: LlmProvider,
  model: string,
  usage: LlmTokenUsage,
): LlmCallUsage {
  const base = {
    provider,
    model,
    inputTokens: usage.inputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    outputTokens: usage.outputTokens,
    requestId: usage.requestId,
  };
  const price = provider === "anthropic-api" ? priceOf(model) : undefined;
  if (price === undefined) return { ...base, costUsd: 0, priceTable: null };
  const prompt = usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  const tier = price.above !== undefined && prompt > price.above.promptTokens ? price.above : price;
  const perToken = (perMillion: number) => perMillion / 1_000_000;
  const costUsd =
    usage.inputTokens * perToken(tier.input) +
    usage.cacheCreationInputTokens * perToken(tier.input * 1.25) +
    usage.cacheReadInputTokens * perToken(price.cacheRead) +
    usage.outputTokens * perToken(tier.output);
  return { ...base, costUsd, priceTable: LLM_PRICE_TABLE };
}
