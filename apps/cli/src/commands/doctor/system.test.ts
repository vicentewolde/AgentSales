import { describe, expect, it } from "vitest";
import { describeCommandError } from "./checks.js";
import { runCommand } from "./system.js";

describe("runCommand", () => {
  it("devuelve la salida de un comando", async () => {
    expect(await runCommand(process.execPath, ["--version"])).toContain(process.version);
  });

  it("un comando inexistente se describe como no encontrado", async () => {
    const error = await runCommand("agentsales-no-existe-xyz", []).catch((e: unknown) => e);

    expect(describeCommandError(error)).toBe("no encontrado");
  });
});
