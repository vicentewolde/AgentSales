import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { findWorkspaceRoot } from "@agentsales/config";
import { describe, expect, it } from "vitest";

// F9.5-T22 (ADR-0036): el modo de una publicación sale de UN lugar, `effectivePublishMode` (core).
// Este test recorre el código fuente (sin los tests) y falla si algo lee el modo del servidor
// (`PUBLISH_MODE` / `publishMode` / `workerMode` / `serverMode`) para decidir una publicación sin
// pasar por esa función. Solo se revisa el código que decide (core, publishers, API y worker): la
// CLI y el panel muestran el modo y preguntan, pero nunca lo fijan (lo fija la API).
//
// Ningún archivo queda exento entero: cada regla se aplica a todos, y la lista blanca exime solo
// una regla en un archivo, con su motivo.

const root = findWorkspaceRoot();
const SCANNED = ["packages/core/src", "packages/publishers/src", "apps/api/src", "apps/worker/src"];

const SERVER_MODE = "(?:publishMode|workerMode|serverMode|PUBLISH_MODE)";

type Rule = "literal" | "dryRun" | "isDryRun" | "apiMode" | "env";

const RULES: ReadonlyArray<{ rule: Rule; name: string; regex: RegExp }> = [
  {
    rule: "literal",
    name: "compara el modo del servidor con un literal",
    regex: new RegExp(
      String.raw`\b${SERVER_MODE}\s*[!=]==?\s*["'](?:live|dry-run)["']|["'](?:live|dry-run)["']\s*[!=]==?\s*[\w.]*\b${SERVER_MODE}\b`,
    ),
  },
  {
    rule: "dryRun",
    name: "deriva dryRun del modo del servidor",
    regex: new RegExp(String.raw`\bdryRun\s*[:=]\s*[\w.]*\b${SERVER_MODE}\b`),
  },
  {
    rule: "isDryRun",
    name: "pasa el modo del servidor a isDryRun",
    regex: new RegExp(String.raw`\bisDryRun\(\s*[\w.]*\b${SERVER_MODE}\b`),
  },
  {
    rule: "apiMode",
    name: "pasa el modo del servidor como modo de una operación (apiMode)",
    regex: new RegExp(String.raw`\bapiMode\s*:\s*[\w.]*\b${SERVER_MODE}\b`),
  },
];

/**
 * `env.PUBLISH_MODE` solo se lee para entregarlo como el modo del servidor: en una asignación
 * a `serverMode`, `workerMode` o `publishMode` (`serverMode: env.PUBLISH_MODE` o
 * `const serverMode = env.PUBLISH_MODE`), lo que después pasa por la función.
 */
const ENV_READ = /\benv\.PUBLISH_MODE\b/g;
const ENV_ALLOWED_BEFORE = /\b(?:serverMode|workerMode|publishMode)\s*[:=]\s*$/;

/** La lista blanca: qué regla se exime en qué archivo, y por qué. */
const ALLOWED: ReadonlyArray<{ path: string; rule: Rule; why: string }> = [
  { path: "packages/core/src/publish-mode.ts", rule: "literal", why: "la función misma" },
  {
    path: "packages/core/src/health.ts",
    rule: "literal",
    why: "/health dice el modo del servidor",
  },
  { path: "apps/api/src/server.ts", rule: "literal", why: "el log del arranque dice el modo" },
];

/**
 * Quita los comentarios (de línea y de bloque) para no marcar lo que solo se explica, sin tocar
 * los textos entre comillas (un `"/*"` o una URL `"https://…"` no abren un comentario). Las
 * plantillas con `${…}` anidadas se tratan como un solo texto: basta para este recorrido.
 */
export function withoutComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const char = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (quote !== null) {
      out += char;
      if (char === "\\") {
        out += next;
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      i += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/** Las reglas que rompe un texto de código (sin comentarios), salvo las eximidas. */
export function violationsIn(source: string, exempt: ReadonlySet<Rule> = new Set()): string[] {
  const code = withoutComments(source);
  const found = RULES.filter(({ rule, regex }) => !exempt.has(rule) && regex.test(code)).map(
    ({ name }) => name,
  );
  if (!exempt.has("env")) {
    for (const match of code.matchAll(ENV_READ)) {
      if (!ENV_ALLOWED_BEFORE.test(code.slice(0, match.index))) {
        found.push("lee PUBLISH_MODE del entorno fuera de serverMode/workerMode/publishMode");
        break;
      }
    }
  }
  return found;
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

const exemptFor = (path: string) =>
  new Set(ALLOWED.filter((item) => item.path === path).map((item) => item.rule));

describe("el modo en vivo es por marca (F9.5-T22)", () => {
  it("el detector marca lo que debe y deja pasar lo permitido", () => {
    expect(violationsIn('const dryRun = deps.publishMode !== "live";')).toHaveLength(2);
    expect(violationsIn('if (deps.workerMode === "dry-run") throw new Error("x");')).toHaveLength(
      1,
    );
    expect(violationsIn("const x = { apiMode: deps.publishMode };")).toHaveLength(1);
    expect(violationsIn("const x = { dryRun: isDryRun(deps.publishMode) };")).toHaveLength(1);
    expect(violationsIn("const live = env.PUBLISH_MODE;")).toHaveLength(1);
    expect(violationsIn("start({ mode: env.PUBLISH_MODE });")).toHaveLength(1);
    // Entregarlo como el modo del servidor sí se puede.
    expect(violationsIn("const deps = { serverMode: env.PUBLISH_MODE };")).toEqual([]);
    expect(
      violationsIn("x({ workerMode: env.PUBLISH_MODE, publishMode: env.PUBLISH_MODE });"),
    ).toEqual([]);
    // Un comentario que lo explica, el modo efectivo y los códigos de error no son lecturas.
    expect(violationsIn('// publishMode === "live" lo decide la función')).toEqual([]);
    expect(violationsIn('/* env.PUBLISH_MODE */ const mode = "PUBLISH_MODE_MISMATCH";')).toEqual(
      [],
    );
    expect(violationsIn('if (apiMode !== "live") throw new Error("x");')).toEqual([]);
    expect(violationsIn("const dryRun = isDryRun(await listingMode(deps, id));")).toEqual([]);
  });

  it("un texto con /* o // no esconde el código que viene después", () => {
    expect(
      violationsIn('const glob = "src/*.ts";\nconst dryRun = deps.publishMode !== "live";\n// */'),
    ).toContain("deriva dryRun del modo del servidor");
    expect(
      violationsIn('const url = "https://example.test";\nif (deps.workerMode === "dry-run") {}'),
    ).toContain("compara el modo del servidor con un literal");
  });

  it("una regresión como la que corrigió T22 (el worker fijando el modo con PUBLISH_MODE) hace fallar el recorrido", () => {
    // Lo que tenía `apps/worker/src/worker.ts` antes de F9.5-T22: aunque fuera ese archivo, falla.
    const regression = [
      "const autoPublish: AutoPublishDeps = {",
      "  lock: listingLock,",
      '  dryRun: env.PUBLISH_MODE !== "live",',
      "};",
    ].join("\n");
    expect(violationsIn(regression, exemptFor("apps/worker/src/worker.ts"))).toEqual([
      "compara el modo del servidor con un literal",
      "deriva dryRun del modo del servidor",
      "lee PUBLISH_MODE del entorno fuera de serverMode/workerMode/publishMode",
    ]);
    expect(violationsIn(regression, exemptFor("apps/api/src/server.ts"))).not.toEqual([]);
  });

  it("nada fuera de la lista blanca lee el modo del servidor para decidir una publicación", async () => {
    const files = (await Promise.all(SCANNED.map((dir) => sourceFiles(join(root, dir))))).flat();
    expect(files.length).toBeGreaterThan(100);
    const found: string[] = [];
    for (const file of files) {
      const path = relative(root, file);
      for (const name of violationsIn(await readFile(file, "utf8"), exemptFor(path))) {
        found.push(`${path}: ${name}`);
      }
    }
    expect(found, "usa effectivePublishMode (core) con la marca de la publicación").toEqual([]);
  });

  it("cada excepción de la lista blanca sigue haciendo falta (y su archivo existe)", async () => {
    for (const { path, rule } of ALLOWED) {
      const source = await readFile(join(root, path), "utf8");
      const without = violationsIn(source);
      const name = RULES.find((item) => item.rule === rule)?.name;
      expect(without, `${path}: ${rule}`).toContain(name);
    }
  });
});
