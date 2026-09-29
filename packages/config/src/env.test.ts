import { describe, expect, it } from "vitest";
import { EnvError, loadEnv } from "./env.js";

const DIRECT_URL =
  "postgresql://owner:fake-pass@ep-test-123.sa-east-1.aws.neon.tech/neondb?sslmode=require";
const POOLER_URL =
  "postgresql://owner:fake-pass@ep-test-123-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require";

const validSource = {
  DATABASE_URL: DIRECT_URL,
  R2_ACCOUNT_ID: "fake-account",
  R2_ACCESS_KEY_ID: "fake-access-key",
  R2_SECRET_ACCESS_KEY: "fake-secret-access-key",
  R2_BUCKET: "agentsales-media",
  APP_ENCRYPTION_KEY: "k".repeat(32),
};

function envErrorOf(source: Record<string, string | undefined>): EnvError {
  try {
    loadEnv(source);
  } catch (error) {
    if (error instanceof EnvError) return error;
    throw error;
  }
  throw new Error("loadEnv no lanzó EnvError");
}

describe("loadEnv", () => {
  it("acepta una env válida y aplica los valores por defecto", () => {
    const env = loadEnv(validSource);

    expect(env.PUBLISH_MODE).toBe("dry-run");
    expect(env.NODE_ENV).toBe("development");
    expect(env.API_PORT).toBe(8787);
    expect(env.WEB_PORT).toBe(5173);
    expect(env.SIGNED_URL_TTL_SECONDS).toBe(3600);
    expect(env.LLM_PROVIDER).toBe("claude-cli");
    expect(env.DATABASE_URL).toBe(DIRECT_URL);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("convierte los números y respeta PUBLISH_MODE=live explícito", () => {
    const env = loadEnv({ ...validSource, API_PORT: "9000", PUBLISH_MODE: "live" });

    expect(env.API_PORT).toBe(9000);
    expect(env.PUBLISH_MODE).toBe("live");
  });

  it("trata las variables vacías como no definidas", () => {
    const env = loadEnv({ ...validSource, ANTHROPIC_API_KEY: "", PUBLISH_MODE: "" });

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PUBLISH_MODE).toBe("dry-run");
  });

  it("ignora variables ajenas al esquema", () => {
    const env = loadEnv({ ...validSource, PATH: "/usr/bin" });

    expect(env).not.toHaveProperty("PATH");
  });

  it("reúne todos los problemas en un mensaje legible sin mostrar valores", () => {
    const shortKey = "clave-corta-secreta";
    const error = envErrorOf({
      ...validSource,
      DATABASE_URL: undefined,
      APP_ENCRYPTION_KEY: shortKey,
    });

    expect(error.issues.map((issue) => issue.variable).sort()).toEqual([
      "APP_ENCRYPTION_KEY",
      "DATABASE_URL",
    ]);
    expect(error.message).toContain("DATABASE_URL: falta (obligatoria)");
    expect(error.message).toContain("APP_ENCRYPTION_KEY: debe tener al menos 32 caracteres");
    expect(error.message).not.toContain(shortKey);
  });

  it("rechaza la conexión por el pooler de Neon", () => {
    const error = envErrorOf({ ...validSource, DATABASE_URL: POOLER_URL });

    expect(error.message).toMatch(/DATABASE_URL: .*-pooler/);
    expect(error.message).not.toContain("fake-pass");
  });

  it("exige sslmode=require en DATABASE_URL", () => {
    const error = envErrorOf({
      ...validSource,
      DATABASE_URL: DIRECT_URL.replace("?sslmode=require", ""),
    });

    expect(error.message).toContain("DATABASE_URL: debe terminar en ?sslmode=require");
  });

  it("rechaza una DATABASE_URL que no es postgresql://", () => {
    const error = envErrorOf({ ...validSource, DATABASE_URL: "mysql://localhost/db" });

    expect(error.message).toContain("DATABASE_URL: debe ser una URL postgresql://");
  });

  it("acepta APP_ENCRYPTION_KEY de 32 caracteres y rechaza la de 31", () => {
    expect(() => loadEnv({ ...validSource, APP_ENCRYPTION_KEY: "a".repeat(32) })).not.toThrow();
    expect(() => loadEnv({ ...validSource, APP_ENCRYPTION_KEY: "a".repeat(31) })).toThrow(EnvError);
  });

  it("rechaza un PUBLISH_MODE desconocido", () => {
    const error = envErrorOf({ ...validSource, PUBLISH_MODE: "foo" });

    expect(error.message).toContain('PUBLISH_MODE: debe ser "dry-run" o "live"');
  });

  it("rechaza un puerto que no es número", () => {
    const error = envErrorOf({ ...validSource, API_PORT: "abc" });

    expect(error.message).toContain("API_PORT: debe ser un puerto entre 1 y 65535");
  });
});
