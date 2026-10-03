import { AppError } from "../errors.js";
import type { LLMProvider, LLMRequest } from "../ports/llm-provider.js";
import { structuredCopy } from "./copy.js";

/** Una respuesta guionada: el dato que devuelve, o el error que lanza. */
export type ScriptedLlmResponse = { data: unknown; model?: string } | { error: AppError };

export type InMemoryLlmProvider = LLMProvider & {
  /** Las peticiones recibidas, en orden (sin el `signal`). */
  requests: Omit<LLMRequest, "signal">[];
};

/**
 * Proveedor de IA para los tests de core: entrega las respuestas en orden y registra las
 * peticiones. Sin respuestas pendientes lanza un error de programación (el test pidió de más).
 * No es el proveedor `fake` de `packages/llm`: core no depende de los adaptadores.
 */
export function createInMemoryLlmProvider(
  responses: readonly ScriptedLlmResponse[] = [],
): InMemoryLlmProvider {
  const pending = [...responses];
  const requests: Omit<LLMRequest, "signal">[] = [];
  return {
    name: "fake",
    requests,
    async generateStructured({ system, prompt, jsonSchema, signal }) {
      // Como el adaptador: con la señal ya disparada no responde (para probar el apagado).
      if (signal?.aborted) {
        throw new AppError("LLM_ABORTED", "Se cortó la llamada a la IA", { retriable: true });
      }
      requests.push(structuredCopy({ system, prompt, jsonSchema }));
      const next = pending.shift();
      if (next === undefined)
        throw new Error("createInMemoryLlmProvider: sin respuestas guionadas");
      if ("error" in next) throw next.error;
      return { data: structuredCopy(next.data), model: next.model ?? "modelo-falso" };
    },
  };
}

/** Errores frecuentes, para guionar respuestas sin repetir códigos. */
export const LLM_ERRORS = {
  authRequired: () =>
    new AppError(
      "LLM_AUTH_REQUIRED",
      "La CLI de Claude no tiene sesión: ábrela con `claude` y usa /login",
    ),
  rateLimited: () =>
    new AppError(
      "LLM_RATE_LIMITED",
      "Se alcanzó el límite de uso del plan de Claude: intenta más tarde",
    ),
  unavailable: () => new AppError("LLM_UNAVAILABLE", "La IA no respondió", { retriable: true }),
} as const;
