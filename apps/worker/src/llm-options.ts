import type { Env } from "@agentsales/config";
import { SAMPLE_CONTENT_DRAFT, SAMPLE_SOCIAL_DRAFT } from "@agentsales/core";
import type { LlmProviderOptions } from "@agentsales/llm";

/**
 * Las opciones del proveedor de IA según `LLM_PROVIDER` (spec F2 §4.5). Con `fake`, devuelve
 * siempre `SAMPLE_CONTENT_DRAFT` (sin red ni cuota). La CLI de Claude recibe el entorno del proceso
 * y se queda solo con sus variables permitidas (`CLAUDE_CLI_ENV_ALLOWLIST`).
 */
type LlmEnv = Pick<
  Env,
  | "LLM_PROVIDER"
  | "LLM_MODEL"
  | "CLAUDE_CLI_PATH"
  | "LLM_TIMEOUT_SECONDS"
  | "ANTHROPIC_API_KEY"
  | "ANTHROPIC_MODEL"
>;

/**
 * La API de Anthropic con la clave del operador (spec F7 §4.7): la de los corredores que no son
 * suyos. `null` sin `ANTHROPIC_API_KEY` (un corredor que la necesita falla con `LLM_NOT_CONFIGURED`).
 */
export function apiLlmOptions(env: LlmEnv): LlmProviderOptions | null {
  if (env.ANTHROPIC_API_KEY === undefined || env.ANTHROPIC_API_KEY === "") return null;
  return {
    provider: "anthropic-api",
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL,
    timeoutMs: env.LLM_TIMEOUT_SECONDS * 1000,
  };
}

export function llmProviderOptions(
  env: LlmEnv,
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
    case "anthropic-api": {
      // El entorno ya exige la clave con este proveedor.
      const options = apiLlmOptions(env);
      if (options === null)
        throw new Error("LLM_PROVIDER=anthropic-api necesita ANTHROPIC_API_KEY");
      return options;
    }
    case "fake":
      return { provider: "fake", data: SAMPLE_CONTENT_DRAFT };
  }
}

/**
 * Las opciones del proveedor para los textos de posts (`post.draft`, F9-T11): las mismas que
 * `llmProviderOptions`, salvo con `fake`, que devuelve `SAMPLE_SOCIAL_DRAFT` (todas las redes en
 * los dos idiomas; core se queda con lo pedido) en vez del borrador de un aviso.
 */
export function socialLlmProviderOptions(
  env: LlmEnv,
  baseEnv: Readonly<Record<string, string | undefined>>,
): LlmProviderOptions {
  return env.LLM_PROVIDER === "fake"
    ? { provider: "fake", data: SAMPLE_SOCIAL_DRAFT }
    : llmProviderOptions(env, baseEnv);
}
