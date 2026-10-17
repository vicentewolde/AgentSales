import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { findWorkspaceRoot } from "@agentsales/config";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = findWorkspaceRoot();
const biome = join(root, "node_modules", ".bin", "biome");

/**
 * Corre Biome sobre un archivo de prueba dentro de `dir` (las reglas aplican por ruta) y lo borra.
 * `*.biome-probe.ts` está en `.gitignore`, por si el test se interrumpe.
 */
async function lintIn(
  dir: readonly string[],
  source: string,
): Promise<{ ok: boolean; output: string }> {
  const file = join(root, ...dir, `${randomUUID()}.biome-probe.ts`);
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

const lintInContracts = (source: string) => lintIn(["apps", "api", "src", "contracts"], source);

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

describe("@agentsales/api/testing · solo en tests (Biome)", () => {
  const probe = 'import { testDeps } from "@agentsales/api/testing";\nexport const x = testDeps;\n';

  it.each([[["apps", "cli", "src"]], [["apps", "web", "src"]], [["packages", "db", "src"]]])(
    "rechaza importarla desde %j",
    async (dir) => {
      const result = await lintIn(dir, probe);
      expect(result.ok).toBe(false);
      expect(result.output).toContain("noRestrictedImports");
    },
  );

  it("la acepta desde test/", async () => {
    expect(await lintIn(["apps", "cli", "test"], probe)).toEqual({ ok: true, output: "" });
  });
});

// docs/01-arquitectura.md ("Tipos alcanzables desde `AppType`"): un global que Node también
// define (`File`, `Blob`…) se nombra como tipo. `z.instanceof(X)` infiere la clase de Node al
// compilar la API, y el panel la recibiría como `import("node:buffer").File` (pasó en F1-T11).
describe("@agentsales/api/contracts · sin z.instanceof", () => {
  it("ningún archivo de contracts usa z.instanceof", async () => {
    const dir = join(root, "apps", "api", "src", "contracts");
    const files = (await readdir(dir)).filter(
      (name) => /\.ts$/.test(name) && !/\.test\.ts$/.test(name),
    );
    const offending: string[] = [];
    for (const name of files) {
      if ((await readFile(join(dir, name), "utf8")).includes("z.instanceof(")) offending.push(name);
    }
    expect(files.length).toBeGreaterThan(0);
    expect(offending).toEqual([]);
  });
});

/**
 * Los módulos de `apps/api/src` alcanzables desde `index.ts` (lo que ve el panel por `AppType`):
 * se siguen los imports relativos desde `index.ts`.
 */
async function reachableFromIndex(): Promise<Map<string, string>> {
  const src = join(root, "apps", "api", "src");
  const seen = new Map<string, string>();
  const pending = [join(src, "index.ts")];
  while (pending.length > 0) {
    const file = pending.pop() ?? "";
    if (seen.has(file)) continue;
    const text = await readFile(file, "utf8");
    seen.set(file, text);
    for (const match of text.matchAll(/(?:from|import)\s+"(\.{1,2}\/[^"]+)"/g)) {
      const target = join(file, "..", (match[1] ?? "").replace(/\.js$/, ".ts"));
      if (!seen.has(target)) pending.push(target);
    }
  }
  return seen;
}

describe("lo que llega a AppType no importa Node (docs/01-arquitectura.md)", () => {
  it("ningún módulo alcanzable desde index.ts importa node:* ni @agentsales/config", async () => {
    const offenders: string[] = [];
    for (const [file, text] of await reachableFromIndex()) {
      if (/from\s+"(node:[^"]+|@agentsales\/config)"/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("server.ts y request-context-node.ts quedan fuera (los compone el punto de entrada)", async () => {
    const files = [...(await reachableFromIndex()).keys()].map((file) => file.split("/").pop());
    expect(files).not.toContain("server.ts");
    expect(files).not.toContain("request-context-node.ts");
    expect(files).toContain("app.ts");
  });
});
