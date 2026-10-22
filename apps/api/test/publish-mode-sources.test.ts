import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { findWorkspaceRoot } from "@agentsales/config";
import { describe, expect, it } from "vitest";

// F9.5-T22 (ADR-0036): el modo de una publicación sale de UN lugar, `effectivePublishMode` (core).
// Este test recorre el código fuente (sin los tests) y falla si algo lee el modo del servidor
// (`PUBLISH_MODE` / `publishMode` / `workerMode` / `serverMode`) para decidir una publicación sin
// pasar por esa función. Solo se revisa el código que decide (core, publishers, API y worker): la
// CLI y el panel muestran el modo y preguntan, pero nunca lo fijan (lo fija la API).

const root = findWorkspaceRoot();
const SCANNED = ["packages/core/src", "packages/publishers/src", "apps/api/src", "apps/worker/src"];

/**
 * Los pocos lugares que SÍ leen el modo del servidor, cada uno con su motivo: la función misma, la
 * composición (el entorno entra aquí), el estado de salud y el banner.
 */
const ALLOWED = new Map<string, string>([
  ["packages/core/src/publish-mode.ts", "la función: effectivePublishMode"],
  ["packages/core/src/health.ts", "el reporte de /health: dice el modo del servidor"],
  ["apps/api/src/server.ts", "composición: lee PUBLISH_MODE del entorno y lo loguea"],
  [
    "apps/worker/src/worker.ts",
    "composición: lee PUBLISH_MODE del entorno y lo pasa como modo del servidor",
  ],
]);

/** Quita los comentarios (de línea y de bloque) para no marcar lo que solo se explica. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const SERVER_MODE = "(?:publishMode|workerMode|serverMode|PUBLISH_MODE)";
const PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  {
    name: "compara el modo del servidor con un literal",
    regex: new RegExp(
      String.raw`\b${SERVER_MODE}\s*[!=]==?\s*["'](?:live|dry-run)["']|["'](?:live|dry-run)["']\s*[!=]==?\s*\b${SERVER_MODE}\b`,
    ),
  },
  {
    name: "deriva dryRun del modo del servidor",
    regex: new RegExp(String.raw`dryRun\s*[:=]\s*[\w.]*\b${SERVER_MODE}\b`),
  },
  {
    name: "pasa el modo del servidor como modo de una operación (apiMode)",
    regex: new RegExp(String.raw`apiMode\s*:\s*[\w.]*\b${SERVER_MODE}\b`),
  },
  {
    name: "lee PUBLISH_MODE del entorno",
    regex: /\benv\.PUBLISH_MODE\b/,
  },
];

/** Las infracciones de un texto de código (sin comentarios). */
export function violationsIn(source: string): string[] {
  const code = withoutComments(source);
  return PATTERNS.filter(({ regex }) => regex.test(code)).map(({ name }) => name);
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "node_modules" || entry.name === "dist" ? [] : sourceFiles(path);
      }
      const isCode = /\.(ts|tsx)$/.test(entry.name);
      const isTest = /\.test\.(ts|tsx)$/.test(entry.name) || /\.d\.ts$/.test(entry.name);
      return isCode && !isTest ? [path] : [];
    }),
  );
  return nested.flat();
}

describe("el modo en vivo es por marca (F9.5-T22)", () => {
  it("el detector marca lo que debe y deja pasar lo permitido", () => {
    expect(violationsIn('const dryRun = deps.publishMode !== "live";')).toHaveLength(2);
    expect(violationsIn('if (deps.workerMode === "dry-run") throw new Error("x");')).toHaveLength(
      1,
    );
    expect(violationsIn("const x = { apiMode: deps.publishMode };")).toHaveLength(1);
    expect(violationsIn("const live = env.PUBLISH_MODE;")).toHaveLength(1);
    // Un comentario que lo explica, el modo efectivo y los códigos de error no son lecturas.
    expect(violationsIn('// publishMode === "live" lo decide la función')).toEqual([]);
    expect(violationsIn('/* env.PUBLISH_MODE */ const mode = "PUBLISH_MODE_MISMATCH";')).toEqual(
      [],
    );
    expect(violationsIn('if (apiMode !== "live") throw new Error("x");')).toEqual([]);
    expect(violationsIn("const dryRun = isDryRun(await listingMode(deps, id));")).toEqual([]);
  });

  it("nada fuera de la lista blanca lee el modo del servidor para decidir una publicación", async () => {
    const files = (await Promise.all(SCANNED.map((dir) => sourceFiles(join(root, dir))))).flat();
    expect(files.length).toBeGreaterThan(100);
    const found: string[] = [];
    for (const file of files) {
      const path = relative(root, file);
      if (ALLOWED.has(path)) continue;
      for (const name of violationsIn(await readFile(file, "utf8"))) found.push(`${path}: ${name}`);
    }
    expect(found, "usa effectivePublishMode (core) con la marca de la publicación").toEqual([]);
  });

  it("la lista blanca no tiene archivos que ya no existen", async () => {
    for (const path of ALLOWED.keys()) {
      await expect(readFile(join(root, path), "utf8")).resolves.toBeTypeOf("string");
    }
  });
});
