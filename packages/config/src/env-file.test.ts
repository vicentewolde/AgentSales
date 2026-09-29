import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findWorkspaceRoot, loadEnvFile } from "./env-file.js";

const VARIABLE = "AGENTSALES_TEST_ENV_FILE";

describe("env-file", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentsales-config-"));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env[VARIABLE];
  });

  it("encuentra la raíz del workspace desde una subcarpeta", () => {
    const nested = join(root, "apps", "api", "src");
    mkdirSync(nested, { recursive: true });

    expect(findWorkspaceRoot(nested)).toBe(root);
  });

  it("falla con un mensaje claro si no hay workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "agentsales-none-"));
    try {
      expect(() => findWorkspaceRoot(outside)).toThrow(/pnpm-workspace\.yaml/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("carga el .env de la raíz en process.env", () => {
    writeFileSync(join(root, ".env"), `${VARIABLE}=desde-archivo\n`);

    expect(loadEnvFile(root)).toBe(true);
    expect(process.env[VARIABLE]).toBe("desde-archivo");
  });

  it("no pisa variables ya definidas", () => {
    process.env[VARIABLE] = "del-entorno";
    writeFileSync(join(root, ".env"), `${VARIABLE}=desde-archivo\n`);

    loadEnvFile(root);

    expect(process.env[VARIABLE]).toBe("del-entorno");
  });

  it("devuelve false si no hay .env", () => {
    expect(loadEnvFile(root)).toBe(false);
  });

  it("devuelve false si no hay workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "agentsales-none-"));
    const cwd = process.cwd();
    try {
      process.chdir(outside);
      expect(loadEnvFile()).toBe(false);
    } finally {
      process.chdir(cwd);
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
