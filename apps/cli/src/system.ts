import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RunCommand } from "./checks.js";

const execFileAsync = promisify(execFile);

/** Ejecuta un comando con timeout y devuelve stdout (o stderr, si el programa escribe ahí). */
export const runCommand: RunCommand = async (command, args) => {
  const { stdout, stderr } = await execFileAsync(command, [...args], { timeout: 10_000 });
  return stdout || stderr;
};

/** Carpeta de navegadores de Playwright según el sistema (o `PLAYWRIGHT_BROWSERS_PATH`). */
function playwrightBrowsersPath(): string {
  const custom = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (custom && custom !== "0") {
    return custom;
  }
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Caches", "ms-playwright");
    case "win32":
      return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright");
    default:
      return join(homedir(), ".cache", "ms-playwright");
  }
}

/** Busca Chromium de Playwright sin depender de Playwright (se instala en F5). */
export function findChromium(): string | null {
  const dir = playwrightBrowsersPath();
  try {
    const found = readdirSync(dir).find((entry) => /^chromium-\d+$/.test(entry));
    return found ? join(dir, found) : null;
  } catch {
    return null;
  }
}
