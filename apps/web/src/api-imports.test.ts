import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname);

/** Archivos de la app (sin tests): lo que llega al navegador. */
function appFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return appFiles(path);
    // `*.biome-probe.ts`: archivos de un instante del test de fronteras de Biome (`apps/api/test`),
    // que puede correr en paralelo.
    const app = /\.tsx?$/.test(entry.name) && !/\.(test|biome-probe)\.tsx?$/.test(entry.name);
    return app ? [path] : [];
  });
}

type ModuleUse = { module: string; typeOnly: boolean };

/**
 * Cada uso de un módulo: `import … from`, `export … from` (de varias líneas también), `import "x"`
 * y `import("x")`. Solo `import type` y `export type` cuentan como uso de tipos.
 */
function modulesUsedBy(source: string): ModuleUse[] {
  const fromClauses = [
    ...source.matchAll(/^(import|export)\s+([\s\S]*?)\s+from\s+"([^"]+)"/gm),
  ].map((match) => ({ module: match[3] ?? "", typeOnly: (match[2] ?? "").startsWith("type ") }));
  const bare = [...source.matchAll(/^import\s+"([^"]+)"/gm)].map((match) => ({
    module: match[1] ?? "",
    typeOnly: false,
  }));
  const dynamic = [...source.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map((match) => ({
    module: match[1] ?? "",
    typeOnly: false,
  }));
  return [...fromClauses, ...bare, ...dynamic];
}

const forbidden = ({ module, typeOnly }: ModuleUse) =>
  (module === "@agentsales/api" && !typeOnly) || module === "@agentsales/api/testing";

// ADR-0011: en tiempo de ejecución el panel solo carga `@agentsales/api/contracts`. De la raíz
// solo toma tipos (`AppType`): un import de valor metería el servidor en el bundle. Biome no
// distingue `import type`, así que esta guardia lo revisa.
describe("imports de @agentsales/api en el panel", () => {
  it("de la raíz solo tipos, y nunca la salida de tests", () => {
    const offending = appFiles().flatMap((file) =>
      modulesUsedBy(readFileSync(file, "utf8"))
        .filter(forbidden)
        .map(({ module }) => `${relative(SRC, file)}: ${module}`),
    );
    expect(offending).toEqual([]);
  });

  it("la guardia detecta cada forma de usar un módulo", () => {
    const uses = modulesUsedBy(
      [
        'import { createApp } from "@agentsales/api";',
        'import type { AppType } from "@agentsales/api";',
        'import {\n  type A,\n  b,\n} from "@agentsales/api";',
        'export { createApp } from "@agentsales/api";',
        'export * from "@agentsales/api";',
        'export type { AppType } from "@agentsales/api";',
        'import "@agentsales/api";',
        'const m = await import("@agentsales/api");',
        'import { errorBodySchema } from "@agentsales/api/contracts";',
        'import { testDeps } from "@agentsales/api/testing";',
      ].join("\n"),
    );

    expect(uses.filter(forbidden)).toHaveLength(7);
    expect(uses.filter((use) => !forbidden(use)).map((use) => use.module)).toEqual([
      "@agentsales/api",
      "@agentsales/api",
      "@agentsales/api/contracts",
    ]);
  });
});
