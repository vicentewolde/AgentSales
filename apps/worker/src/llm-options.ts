import type { Env } from "@agentsales/config";
import { SAMPLE_CONTENT_DRAFT } from "@agentsales/core";
import type { LlmProviderOptions } from "@agentsales/llm";

/**
 * Las opciones del proveedor de IA según `LLM_PROVIDER` (spec F2 §4.5). Con `fake`, devuelve
 * siempre `SAMPLE_CONTENT_DRAFT` (sin red ni cuota). La CLI de Claude recibe el entorno del proceso
 * y se queda solo con sus variables permitidas (`CLAUDE_CLI_ENV_ALLOWLIST`).
 */
export function llmProviderOptions(
  env: Pick<Env, "LLM_PROVIDER" | "LLM_MODEL" | "CLAUDE_CLI_PATH" | "LLM_TIMEOUT_SECONDS">,
  baseEnv: Readonly<Record<string, string | undefined>>,
): LlmProviderOptions {
  switch (env.LLM_PROVIDER) {
    case "claude-cli":
      return {
        provider: "claude-cli",
        cliPath: env.CLAUDE_CLI_PATH,
        model: env.LLM_MODEL,
        timeoutMs: env.LLM_TIMEOUT_SECONDS * 1000,
        baseEnv,
      };
    case "anthropic-api":
      return { provider: "anthropic-api" };
    case "fake":
      return { provider: "fake", data: SAMPLE_CONTENT_DRAFT };
  }
}
