import { SAMPLE_CONTENT_DRAFT, SAMPLE_SOCIAL_DRAFT } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import {
  apiLlmOptions,
  llmProviderOptions,
  planLlmProviderOptions,
  socialLlmProviderOptions,
} from "./llm-options.js";

const env = {
  LLM_MODEL: "sonnet",
  CLAUDE_CLI_PATH: "/opt/claude",
  LLM_TIMEOUT_SECONDS: 180,
  ANTHROPIC_MODEL: "claude-sonnet-5-5",
  ANTHROPIC_API_KEY: undefined,
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

  it("con anthropic-api usa la clave, el modelo de la API y el tope en ms (F7-T11)", () => {
    expect(
      llmProviderOptions(
        { ...env, LLM_PROVIDER: "anthropic-api", ANTHROPIC_API_KEY: "sk-ant-de-prueba" },
        {},
      ),
    ).toEqual({
      provider: "anthropic-api",
      apiKey: "sk-ant-de-prueba",
      model: "claude-sonnet-5-5",
      timeoutMs: 180_000,
    });
  });

  it("la API para los corredores que no son del operador, solo con clave (F7-T12)", () => {
    expect(apiLlmOptions({ ...env, LLM_PROVIDER: "claude-cli" })).toBeNull();
    expect(
      apiLlmOptions({ ...env, LLM_PROVIDER: "claude-cli", ANTHROPIC_API_KEY: "sk-ant-de-prueba" }),
    ).toMatchObject({ provider: "anthropic-api", model: "claude-sonnet-5-5" });
  });

  it("los textos de posts: con fake, el borrador de ejemplo de un post; si no, el mismo proveedor (F9-T11)", () => {
    expect(socialLlmProviderOptions({ ...env, LLM_PROVIDER: "fake" }, {})).toEqual({
      provider: "fake",
      data: SAMPLE_SOCIAL_DRAFT,
    });
    const baseEnv = { PATH: "/usr/bin" };
    expect(socialLlmProviderOptions({ ...env, LLM_PROVIDER: "claude-cli" }, baseEnv)).toEqual(
      llmProviderOptions({ ...env, LLM_PROVIDER: "claude-cli" }, baseEnv),
    );
  });

  it("el plan de ideas: con fake, el plan de ejemplo armado con el prompt; si no, el mismo proveedor (F9-T20)", () => {
    const fake = planLlmProviderOptions({ ...env, LLM_PROVIDER: "fake" }, {});
    expect(fake).toMatchObject({ provider: "fake", data: null });
    // Sin el bloque de datos del plan, el ejemplo no inventa ideas.
    expect(
      fake.provider === "fake" ? fake.respond?.({ system: "", prompt: "", jsonSchema: {} }) : null,
    ).toEqual({ ideas: [], warnings: ["El ejemplo no encontró los datos del plan en el prompt"] });
    const baseEnv = { PATH: "/usr/bin" };
    expect(planLlmProviderOptions({ ...env, LLM_PROVIDER: "claude-cli" }, baseEnv)).toEqual(
      llmProviderOptions({ ...env, LLM_PROVIDER: "claude-cli" }, baseEnv),
    );
  });
});
