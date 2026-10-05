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

    expect(error.message).toContain("DATABASE_URL: debe incluir sslmode=require");
  });

  it("rechaza el pooler aunque el host venga en mayúsculas", () => {
    const error = envErrorOf({
      ...validSource,
      DATABASE_URL: POOLER_URL.replace("ep-test-123-pooler", "EP-TEST-123-POOLER"),
    });

    expect(error.message).toMatch(/DATABASE_URL: el host contiene -pooler/);
  });

  it("rechaza channel_binding en DATABASE_URL", () => {
    const error = envErrorOf({
      ...validSource,
      DATABASE_URL: `${DIRECT_URL}&channel_binding=require`,
    });

    expect(error.message).toContain("DATABASE_URL: no debe incluir channel_binding");
  });

  it("rechaza una DATABASE_URL que no es postgresql://", () => {
    const error = envErrorOf({ ...validSource, DATABASE_URL: "mysql://localhost/db" });

    expect(error.message).toContain("DATABASE_URL: debe ser una URL postgresql://");
  });

  it("acepta APP_ENCRYPTION_KEY de 32 caracteres y rechaza la de 31", () => {
    expect(() => loadEnv({ ...validSource, APP_ENCRYPTION_KEY: "a".repeat(32) })).not.toThrow();
    expect(() => loadEnv({ ...validSource, APP_ENCRYPTION_KEY: "a".repeat(31) })).toThrow(EnvError);
  });

  it("con LLM_PROVIDER=anthropic-api exige ANTHROPIC_API_KEY (F2-T04), sin mostrar valores", () => {
    const error = envErrorOf({ ...validSource, LLM_PROVIDER: "anthropic-api" });
    expect(error.issues).toEqual([
      {
        variable: "ANTHROPIC_API_KEY",
        message: 'falta (obligatoria con LLM_PROVIDER="anthropic-api")',
      },
    ]);
    const env = loadEnv({
      ...validSource,
      LLM_PROVIDER: "anthropic-api",
      ANTHROPIC_API_KEY: "sk-test-clave-falsa",
    });
    expect(env.LLM_PROVIDER).toBe("anthropic-api");
    // Con claude-cli no hace falta.
    expect(loadEnv(validSource).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("CLAUDE_CLI_PATH y LLM_TIMEOUT_SECONDS tienen valores por defecto y un rango (F2-T04)", () => {
    const env = loadEnv(validSource);
    expect([env.CLAUDE_CLI_PATH, env.LLM_TIMEOUT_SECONDS]).toEqual(["claude", 180]);
    expect(loadEnv({ ...validSource, LLM_TIMEOUT_SECONDS: "60" }).LLM_TIMEOUT_SECONDS).toBe(60);
    for (const value of ["5", "601", "1.5"]) {
      expect(envErrorOf({ ...validSource, LLM_TIMEOUT_SECONDS: value }).issues[0]?.variable).toBe(
        "LLM_TIMEOUT_SECONDS",
      );
    }
  });

  it("FFMPEG_PATH y FFPROBE_PATH tienen valores por defecto (F2-T07)", () => {
    const env = loadEnv(validSource);
    expect([env.FFMPEG_PATH, env.FFPROBE_PATH]).toEqual(["ffmpeg", "ffprobe"]);
    expect(loadEnv({ ...validSource, FFPROBE_PATH: "/opt/ffprobe" }).FFPROBE_PATH).toBe(
      "/opt/ffprobe",
    );
  });

  it("rechaza un LLM_PROVIDER desconocido listando las tres opciones", () => {
    const error = envErrorOf({ ...validSource, LLM_PROVIDER: "openai" });

    expect(error.message).toContain(
      'LLM_PROVIDER: debe ser "claude-cli", "anthropic-api" o "fake"',
    );
  });

  it("rechaza un PUBLISH_MODE desconocido", () => {
    const error = envErrorOf({ ...validSource, PUBLISH_MODE: "foo" });

    expect(error.message).toContain('PUBLISH_MODE: debe ser "dry-run" o "live"');
  });

  it("recorta los espacios de los valores", () => {
    const env = loadEnv({ ...validSource, R2_BUCKET: "  agentsales-media\n", API_PORT: " 9000 " });

    expect(env.R2_BUCKET).toBe("agentsales-media");
    expect(env.API_PORT).toBe(9000);
  });

  it.each(["0x10", "1e3", "80.5", "70000"])("rechaza el puerto %s", (value) => {
    expect(() => loadEnv({ ...validSource, API_PORT: value })).toThrow(EnvError);
  });

  it("limita SIGNED_URL_TTL_SECONDS a 7 días", () => {
    expect(
      loadEnv({ ...validSource, SIGNED_URL_TTL_SECONDS: "604800" }).SIGNED_URL_TTL_SECONDS,
    ).toBe(604800);
    expect(() => loadEnv({ ...validSource, SIGNED_URL_TTL_SECONDS: "604801" })).toThrow(EnvError);
  });

  it.each([
    ["NODE_ENV", "SECRETVAL"],
    ["LOG_LEVEL", "SECRETVAL"],
    ["PUBLISH_MODE", "SECRETVAL"],
    ["LLM_PROVIDER", "SECRETVAL"],
    ["API_PORT", "SECRETVAL"],
    ["SIGNED_URL_TTL_SECONDS", "SECRETVAL"],
    ["MAX_VIDEO_MB", "SECRETVAL"],
    ["MAX_IMPORT_UPLOAD_MB", "SECRETVAL"],
    ["DATABASE_URL", "SECRETVAL"],
    ["DATABASE_URL", "postgresql://u:SECRETVAL@ep-x-pooler.neon.tech/db?channel_binding=require"],
    ["APP_ENCRYPTION_KEY", "SECRETVAL"],
    ["INSTAGRAM_REDIRECT_URI", "SECRETVAL"],
    ["META_APP_SECRET", "SECRETVAL"],
  ])("el error de %s no muestra el valor recibido", (variable, value) => {
    const error = envErrorOf({ ...validSource, [variable]: value });

    expect(error.issues.map((issue) => issue.variable)).toContain(variable);
    expect(error.message).not.toContain("SECRETVAL");
  });

  it("rechaza un puerto que no es número", () => {
    const error = envErrorOf({ ...validSource, API_PORT: "abc" });

    expect(error.message).toContain("API_PORT: debe ser un puerto entre 1 y 65535");
  });

  describe("Instagram (F3)", () => {
    it("lee el par de la app de Instagram y la dirección de retorno por defecto", () => {
      const env = loadEnv({
        ...validSource,
        INSTAGRAM_APP_ID: "123",
        INSTAGRAM_APP_SECRET: "fake-secret",
      });

      expect(env).toMatchObject({
        INSTAGRAM_APP_ID: "123",
        INSTAGRAM_APP_SECRET: "fake-secret",
        INSTAGRAM_REDIRECT_URI: "http://localhost:8787/oauth/instagram/callback",
      });
      expect(loadEnv(validSource).INSTAGRAM_APP_ID).toBeUndefined();
    });

    it("acepta una dirección https y rechaza una que no es URL http(s)", () => {
      expect(
        loadEnv({ ...validSource, INSTAGRAM_REDIRECT_URI: "https://agentsales.test/cb" })
          .INSTAGRAM_REDIRECT_URI,
      ).toBe("https://agentsales.test/cb");
      expect(
        envErrorOf({ ...validSource, INSTAGRAM_REDIRECT_URI: "ftp://x/cb" }).message,
      ).toContain("INSTAGRAM_REDIRECT_URI: debe ser una URL http:// o https://");
    });

    it("avisa las variables META_* con su nombre nuevo, junto con los demás problemas", () => {
      const error = envErrorOf({
        ...validSource,
        META_APP_ID: "1",
        META_REDIRECT_URI: "http://localhost/cb",
        API_PORT: "abc",
      });

      expect(error.issues).toEqual([
        { variable: "META_APP_ID", message: "se renombró a INSTAGRAM_APP_ID" },
        { variable: "META_REDIRECT_URI", message: "se renombró a INSTAGRAM_REDIRECT_URI" },
        { variable: "API_PORT", message: "debe ser un puerto entre 1 y 65535" },
      ]);
    });

    it("una META_* vacía no cuenta (como cualquier variable vacía)", () => {
      expect(() => loadEnv({ ...validSource, META_APP_ID: "" })).not.toThrow();
    });
  });
});
