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

/** Cada `import … from "<módulo>"` con su texto completo (incluye los de varias líneas). */
const importsOf = (source: string) =>
  [...source.matchAll(/^import\s+([\s\S]*?)\s+from\s+"([^"]+)";/gm)].map((match) => ({
    clause: match[1] ?? "",
    module: match[2] ?? "",
  }));

// ADR-0011: en tiempo de ejecución el panel solo carga `@agentsales/api/contracts`. De la raíz
// solo toma tipos (`AppType`): un import de valor metería el servidor en el bundle. Biome no
// distingue `import type`, así que esta guardia lo revisa.
describe("imports de @agentsales/api en el panel", () => {
  it("de la raíz solo `import type`, y nunca la salida de tests", () => {
    const offending = appFiles().flatMap((file) =>
      importsOf(readFileSync(file, "utf8"))
        .filter(
          ({ clause, module }) =>
            (module === "@agentsales/api" && !clause.startsWith("type ")) ||
            module === "@agentsales/api/testing",
        )
        .map(({ module }) => `${relative(SRC, file)}: ${module}`),
    );
    expect(offending).toEqual([]);
  });

  it("la guardia detecta un import de valor", () => {
    expect(
      importsOf(
        'import { createApp } from "@agentsales/api";\nimport type { AppType } from "@agentsales/api";\n',
      ),
    ).toEqual([
      { clause: "{ createApp }", module: "@agentsales/api" },
      { clause: "type { AppType }", module: "@agentsales/api" },
    ]);
  });
});
