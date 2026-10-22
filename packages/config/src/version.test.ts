import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProductVersion } from "./version.js";

describe("readProductVersion", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentsales-version-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lee la versión del package.json raíz del proyecto", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(readProductVersion()).toBe(pkg.version);
  });

  it("sube desde una carpeta interna hasta la raíz del workspace", () => {
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.3.4" }));
    const inner = join(root, "apps", "cli", "dist");
    mkdirSync(inner, { recursive: true });
    // El package.json de la app no cuenta: manda el de la raíz.
    writeFileSync(join(root, "apps", "cli", "package.json"), JSON.stringify({ version: "9.9.9" }));

    expect(readProductVersion(inner)).toBe("2.3.4");
  });

  it("sin versión en la raíz, 0.0.0", () => {
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));

    expect(readProductVersion(root)).toBe("0.0.0");
  });
});
