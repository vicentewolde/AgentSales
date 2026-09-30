import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiPort, DEFAULT_API_PORT, loadEnvironment } from "./env.js";

const valid = {
  DATABASE_URL: "postgresql://o:fake-pass@ep-test.neon.tech/db?sslmode=require",
  R2_ACCOUNT_ID: "a",
  R2_ACCESS_KEY_ID: "b",
  R2_SECRET_ACCESS_KEY: "c",
  R2_BUCKET: "agentsales-media",
  APP_ENCRYPTION_KEY: "k".repeat(32),
  API_PORT: "9001",
};

const roots: string[] = [];
function workspace(withEnv: "file" | "dir" | "none"): string {
  const root = mkdtempSync(join(tmpdir(), "agentsales-cli-"));
  roots.push(root);
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  if (withEnv === "file") writeFileSync(join(root, ".env"), "AGENTSALES_CLI_TEST=1\n");
  if (withEnv === "dir") mkdirSync(join(root, ".env"));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.AGENTSALES_CLI_TEST;
});

describe("loadEnvironment", () => {
  it("con variables válidas devuelve el entorno", () => {
    const result = loadEnvironment({ root: workspace("file"), source: valid });

    expect(result.ok && result.env.API_PORT).toBe(9001);
  });

  it("con variables inválidas devuelve los problemas, sin lanzar", () => {
    const result = loadEnvironment({ root: workspace("file"), source: {} });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.fileFound).toBe(true);
    expect(!result.ok && result.issues.map((issue) => issue.variable)).toContain("DATABASE_URL");
  });

  it("informa si no hay archivo .env", () => {
    const result = loadEnvironment({ root: workspace("none"), source: {} });

    expect(!result.ok && result.fileFound).toBe(false);
  });

  it("si el .env no se puede leer, lo informa sin lanzar", () => {
    const result = loadEnvironment({ root: workspace("dir"), source: valid });

    expect(result).toEqual({
      ok: false,
      fileFound: true,
      issues: [{ variable: ".env", message: "no se pudo leer el archivo" }],
    });
  });
});

describe("apiPort", () => {
  const invalid = { ok: false, fileFound: true, issues: [] } as const;

  it("usa el puerto del entorno válido", () => {
    const result = loadEnvironment({ root: workspace("file"), source: valid });
    expect(apiPort(result)).toBe(9001);
  });

  it.each([
    [" 9002 ", 9002],
    ["70000", DEFAULT_API_PORT],
    ["0x10", DEFAULT_API_PORT],
    [undefined, DEFAULT_API_PORT],
  ])("con .env inválido lee API_PORT=%j → %i", (raw, expected) => {
    expect(apiPort(invalid, { API_PORT: raw })).toBe(expected);
  });
});
