import { SAMPLE_CONTENT_DRAFT } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { llmProviderOptions } from "./llm-options.js";

const env = {
  LLM_MODEL: "sonnet",
  CLAUDE_CLI_PATH: "/opt/claude",
  LLM_TIMEOUT_SECONDS: 180,
} as const;

describe("proveedor de IA del worker", () => {
  it("con fake devuelve siempre el borrador de ejemplo", () => {
    expect(llmProviderOptions({ ...env, LLM_PROVIDER: "fake" }, {})).toEqual({
      provider: "fake",
      data: SAMPLE_CONTENT_DRAFT,
    });
  });

  it("con claude-cli pasa la ruta, el modelo, el tope en ms y el entorno base", () => {
    const baseEnv = { PATH: "/usr/bin" };
    expect(llmProviderOptions({ ...env, LLM_PROVIDER: "claude-cli" }, baseEnv)).toEqual({
      provider: "claude-cli",
      cliPath: "/opt/claude",
      model: "sonnet",
      timeoutMs: 180_000,
      baseEnv,
    });
  });

  it("con anthropic-api usa el stub de F2", () => {
    expect(llmProviderOptions({ ...env, LLM_PROVIDER: "anthropic-api" }, {})).toEqual({
      provider: "anthropic-api",
    });
  });
});
