import { describe, expect, it } from "vitest";

describe("guardia de los tests (F2-T04)", () => {
  it("CLAUDE_CLI_PATH apunta a un ejecutable que no existe: ningún test llama a la CLI real", () => {
    expect(process.env.CLAUDE_CLI_PATH).toBe("/agentsales-tests/claude-real-bloqueada");
  });
});
