import type { LLMProvider } from "@agentsales/core";
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
      model?: string;
    };

/**
 * Proveedor `fake` de ejecución (`LLM_PROVIDER=fake`, `eval:content --provider fake`): devuelve
 * siempre el mismo dato, sin red. Los tests de core usan su propio doble en
 * `@agentsales/core/testing`, con respuestas en orden.
 */
function createFakeProvider(data: unknown, model = "fake"): LLMProvider {
  return {
    name: "fake",
    async generateStructured() {
      return { data: structuredClone(data), model };
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
      return createFakeProvider(options.data, options.model);
  }
}
