import { z } from "zod";

const MIN_ENCRYPTION_KEY_LENGTH = 32;

const requiredText = z.string({ error: "falta (obligatoria)" }).min(1, "falta (obligatoria)");

const positiveInt = (description: string) =>
  z.coerce
    .number({ error: `debe ser ${description}` })
    .int(`debe ser ${description}`)
    .positive(`debe ser ${description}`);

const port = z.coerce
  .number({ error: "debe ser un puerto entre 1 y 65535" })
  .int("debe ser un puerto entre 1 y 65535")
  .min(1, "debe ser un puerto entre 1 y 65535")
  .max(65535, "debe ser un puerto entre 1 y 65535");

const databaseUrl = requiredText.superRefine((value, ctx) => {
  const url = URL.parse(value);
  if (!url || (url.protocol !== "postgres:" && url.protocol !== "postgresql:")) {
    ctx.addIssue({ code: "custom", message: "debe ser una URL postgresql://" });
    return;
  }
  if (url.hostname.includes("-pooler")) {
    ctx.addIssue({
      code: "custom",
      message:
        "usa el pooler de Neon (-pooler); copia la conexión directa, sin -pooler (ver docs/09-alta-neon-r2.md)",
    });
  }
  if (url.searchParams.get("sslmode") !== "require") {
    ctx.addIssue({ code: "custom", message: "debe terminar en ?sslmode=require" });
  }
});

const envSchema = z.object({
  // General
  NODE_ENV: z
    .enum(["development", "production", "test"], {
      error: 'debe ser "development", "production" o "test"',
    })
    .default("development"),
  TZ_DISPLAY: z.string().default("America/Santiago"),
  API_PORT: port.default(8787),
  WEB_PORT: port.default(5173),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"], {
      error: "debe ser fatal, error, warn, info, debug, trace o silent",
    })
    .default("info"),
  PUBLISH_MODE: z
    .enum(["dry-run", "live"], { error: 'debe ser "dry-run" o "live"' })
    .default("dry-run"),

  // Base de datos (Neon, conexión directa)
  DATABASE_URL: databaseUrl,

  // Archivos (Cloudflare R2)
  R2_ACCOUNT_ID: requiredText,
  R2_ACCESS_KEY_ID: requiredText,
  R2_SECRET_ACCESS_KEY: requiredText,
  R2_BUCKET: requiredText,
  SIGNED_URL_TTL_SECONDS: positiveInt("un número entero de segundos mayor que 0").default(3600),

  // Seguridad: la clave de 32 bytes se deriva con HKDF-SHA256 donde se cifra (F3)
  APP_ENCRYPTION_KEY: requiredText.min(
    MIN_ENCRYPTION_KEY_LENGTH,
    `debe tener al menos ${MIN_ENCRYPTION_KEY_LENGTH} caracteres`,
  ),

  // IA (F2)
  LLM_PROVIDER: z
    .enum(["claude-cli", "anthropic-api", "fake"], {
      error: 'debe ser "claude-cli", "anthropic-api" o "fake"',
    })
    .default("claude-cli"),
  LLM_MODEL: z.string().default("sonnet"),
  ANTHROPIC_API_KEY: z.string().optional(),

  // Medios (F1-F2)
  MAX_VIDEO_MB: positiveInt("un número entero de MB mayor que 0").default(300),
  FFMPEG_PATH: z.string().default("ffmpeg"),

  // Instagram (F3)
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_REDIRECT_URI: z.string().default("http://localhost:8787/oauth/instagram/callback"),

  // Mercado Libre / Portal Inmobiliario (F4)
  ML_APP_ID: z.string().optional(),
  ML_CLIENT_SECRET: z.string().optional(),
  ML_REDIRECT_URI: z.string().optional(),
  ML_SITE_ID: z.string().default("MLC"),

  // Facebook Marketplace (F5)
  MARKETPLACE_DAILY_LIMIT: positiveInt("un número entero mayor que 0").default(3),
  BROWSER_PROFILES_DIR: z.string().default("./.browser-profiles"),
});

export type Env = Readonly<z.infer<typeof envSchema>>;

export type EnvIssue = { variable: string; message: string };

/** Error de configuración. El mensaje nombra las variables con problemas, nunca sus valores. */
export class EnvError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    const lines = issues.map((issue) => `  - ${issue.variable}: ${issue.message}`);
    super(`Configuración inválida en .env (ver .env.example):\n${lines.join("\n")}`);
    this.name = "EnvError";
    this.issues = issues;
  }
}

/**
 * Valida las variables de entorno y devuelve una configuración tipada e inmutable.
 * Las variables vacías (`CLAVE=`) cuentan como no definidas.
 * Lanza `EnvError` con todos los problemas juntos.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ""),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map((issue) => ({
        variable: issue.path.join(".") || "(entorno)",
        message: issue.message,
      })),
    );
  }
  return Object.freeze(result.data);
}
