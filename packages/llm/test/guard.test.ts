import { isAppError } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { createLlmProvider } from "../src/index.js";

describe("guardia de los tests (F2-T04)", () => {
  it("CLAUDE_CLI_PATH apunta a un ejecutable que no existe: ningún test llama a la CLI real", async () => {
    const cliPath = process.env.CLAUDE_CLI_PATH ?? "claude";
    expect(cliPath).toBe("/agentsales-tests/claude-real-bloqueada");
    // Un proveedor armado desde el entorno, como lo haría el worker, falla sin llamar a nada.
    const provider = createLlmProvider({
      provider: "claude-cli",
      cliPath,
      model: "sonnet",
      timeoutMs: 5000,
      baseEnv: process.env,
    });
    const error = await provider
      .generateStructured({ system: "s", prompt: "p", jsonSchema: {} })
      .catch((caught: unknown) => caught);
    expect(isAppError(error) && error.code).toBe("LLM_NOT_CONFIGURED");
  });
});
