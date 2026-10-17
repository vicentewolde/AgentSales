import { z } from "zod";
import { LLM_PROVIDERS } from "./enums.js";

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
