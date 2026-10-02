import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { findWorkspaceRoot } from "@agentsales/config";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = findWorkspaceRoot();
const biome = join(root, "node_modules", ".bin", "biome");

/**
 * Corre Biome sobre un archivo de prueba dentro de `apps/api/src/contracts/` (la regla aplica por
 * ruta) y lo borra. `*.biome-probe.ts` está en `.gitignore`, por si el test se interrumpe.
 */
async function lintInContracts(source: string): Promise<{ ok: boolean; output: string }> {
  const file = join(root, "apps", "api", "src", "contracts", `${randomUUID()}.biome-probe.ts`);
  await writeFile(file, source);
  try {
    await run(biome, ["lint", "--vcs-use-ignore-file=false", file], { cwd: root });
    return { ok: true, output: "" };
  } catch (error) {
    // `execFile` rechaza con un error que trae la salida del proceso en `stdout` y `stderr`.
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${stdout}${stderr}` };
  } finally {
    await rm(file, { force: true });
  }
}

describe("@agentsales/api/contracts · frontera (Biome)", () => {
  it.each([
    ['import { loadEnv } from "@agentsales/config";\nexport const x = loadEnv;\n'],
    ['import { readFile } from "node:fs/promises";\nexport const x = readFile;\n'],
    ['import { Hono } from "hono";\nexport const x = Hono;\n'],
    // `../` sale de `contracts/` al código del servidor (hono, pino…).
    ['import { errorJson } from "../errors.js";\nexport const x = errorJson;\n'],
  ])("rechaza %s", async (source) => {
    const result = await lintInContracts(source);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("noRestrictedImports");
  });

  it("acepta zod, @agentsales/core e imports de ./", async () => {
    const result = await lintInContracts(
      'import { LISTING_STATUSES } from "@agentsales/core";\nimport { z } from "zod";\nimport { errorBodySchema } from "./index.js";\nexport const x = [z.enum(LISTING_STATUSES), errorBodySchema];\n',
    );
    expect(result).toEqual({ ok: true, output: "" });
  });
});
