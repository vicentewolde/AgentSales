import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeCommandError } from "./checks.js";
import { findChromium, playwrightBrowsersPath, runCommand } from "./system.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("findChromium", () => {
  it("devuelve la revisión más nueva de chromium e ignora headless_shell", () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-playwright-"));
    dirs.push(dir);
    for (const name of [
      "chromium-999",
      "chromium-1217",
      "chromium_headless_shell-2000",
      "ffmpeg-1011",
    ]) {
      mkdirSync(join(dir, name));
    }

    expect(findChromium(dir)).toBe(join(dir, "chromium-1217"));
  });

  it("devuelve null si no hay chromium o no existe la carpeta", () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-playwright-"));
    dirs.push(dir);

    expect(findChromium(dir)).toBeNull();
    expect(findChromium(join(dir, "no-existe"))).toBeNull();
  });

  it("respeta PLAYWRIGHT_BROWSERS_PATH", () => {
    expect(playwrightBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: "/tmp/navegadores" })).toBe(
      "/tmp/navegadores",
    );
  });
});

describe("runCommand", () => {
  it("devuelve la salida de un comando", async () => {
    expect(await runCommand(process.execPath, ["--version"])).toContain(process.version);
  });

  it("un comando inexistente se describe como no encontrado", async () => {
    const error = await runCommand("agentsales-no-existe-xyz", []).catch((e: unknown) => e);

    expect(describeCommandError(error)).toBe("no encontrado");
  });
});
