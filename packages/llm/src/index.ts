import type { LLMProvider, LLMRequest } from "@agentsales/core";
import { type AnthropicApiOptions, createAnthropicApiProvider } from "./anthropic-api.js";
import { type ClaudeCliOptions, createClaudeCliProvider } from "./claude-cli.js";

export {
  type AnthropicApiOptions,
  anthropicError,
  createAnthropicApiProvider,
} from "./anthropic-api.js";

export {
  CLAUDE_CLI_ENV_ALLOWLIST,
  type ClaudeCliOptions,
  claudeCliArgs,
  claudeCliEnv,
  createClaudeCliProvider,
} from "./claude-cli.js";

export type LlmProviderOptions =
  | ({ provider: "claude-cli" } & ClaudeCliOptions)
  | ({ provider: "anthropic-api" } & AnthropicApiOptions)
  | {
      provider: "fake";
      /** Lo que devuelve siempre (por ejemplo, un borrador de ejemplo de core). */
      data: unknown;
      /**
       * Si está, arma la respuesta con la petición en vez de devolver `data` (F9-T20: el plan de
       * ejemplo lee del prompt el período y la cadencia, `samplePlanResponse` de core). Sin red.
       */
      respond?: (request: LLMRequest) => unknown;
      model?: string;
    };

/**
 * Proveedor `fake` de ejecución (`LLM_PROVIDER=fake`, `eval:content --provider fake`): devuelve
 * siempre el mismo dato (o lo que arma `respond` con la petición), sin red. Los tests de core usan
 * su propio doble en `@agentsales/core/testing`, con respuestas en orden.
 */
function createFakeProvider(
  data: unknown,
  model = "fake",
  respond?: (request: LLMRequest) => unknown,
): LLMProvider {
  return {
    name: "fake",
    async generateStructured(request) {
      return { data: structuredClone(respond === undefined ? data : respond(request)), model };
    },
  };
}

/** El proveedor de IA según la configuración (`LLM_PROVIDER`); lo compone el worker. */
export function createLlmProvider(options: LlmProviderOptions): LLMProvider {
  switch (options.provider) {
    case "claude-cli":
      return createClaudeCliProvider(options);
    case "anthropic-api":
      return createAnthropicApiProvider(options);
    case "fake":
      return createFakeProvider(options.data, options.model, options.respond);
  }
}
