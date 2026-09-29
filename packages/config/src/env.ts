import { LLM_PROVIDERS, PUBLISH_MODES } from "@agentsales/core";
import { z } from "zod";

/** `["a", "b", "c"]` → `"a", "b" o "c"` (para mensajes de error). */
const listOf = (values: readonly string[]) =>
  values
    .map((value) => `"${value}"`)
    .join(", ")
    .replace(/, ([^,]*)$/, " o $1");

const MIN_ENCRYPTION_KEY_LENGTH = 32;

const requiredText = z.string({ error: "falta (obligatoria)" }).min(1, "falta (obligatoria)");

/** Entero escrito solo con dígitos (rechaza `0x10`, `1e3`, `80.5`) dentro de un rango. */
const intInRange = (min: number, max: number, message: string) =>
  z
    .string()
    .regex(/^\d+$/, message)
    .transform(Number)
    .pipe(z.number().int(message).min(min, message).max(max, message));

const positiveInt = (description: string) =>
  intInRange(1, Number.MAX_SAFE_INTEGER, `debe ser ${description}`);

const port = intInRange(1, 65535, "debe ser un puerto entre 1 y 65535");

/** Máximo de una URL prefirmada de R2 (ADR-0007). */
const MAX_SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

const databaseUrl = requiredText.superRefine((value, ctx) => {
  const url = URL.parse(value);
  if (!url || (url.protocol !== "postgres:" && url.protocol !== "postgresql:")) {
    ctx.addIssue({ code: "custom", message: "debe ser una URL postgresql://" });
    return;
  }
  if (url.hostname.toLowerCase().includes("-pooler")) {
    ctx.addIssue({
      code: "custom",
      message:
        "el host contiene -pooler; usa la conexión directa de Neon, sin -pooler (ver docs/09-alta-neon-r2.md)",
    });
  }
  if (url.searchParams.get("sslmode") !== "require") {
    ctx.addIssue({ code: "custom", message: "debe incluir sslmode=require" });
  }
  if (url.searchParams.has("channel_binding")) {
    ctx.addIssue({
      code: "custom",
      message: "no debe incluir channel_binding (quítalo de la URL que copia Neon)",
    });
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
    .enum(PUBLISH_MODES, { error: `debe ser ${listOf(PUBLISH_MODES)}` })
    .default("dry-run"),

  // Base de datos (Neon, conexión directa)
  DATABASE_URL: databaseUrl,

  // Archivos (Cloudflare R2)
  R2_ACCOUNT_ID: requiredText,
  R2_ACCESS_KEY_ID: requiredText,
  R2_SECRET_ACCESS_KEY: requiredText,
  R2_BUCKET: requiredText,
  SIGNED_URL_TTL_SECONDS: intInRange(
    1,
    MAX_SIGNED_URL_TTL_SECONDS,
    `debe ser un número entero de segundos entre 1 y ${MAX_SIGNED_URL_TTL_SECONDS} (7 días)`,
  ).default(3600),

  // Seguridad: la clave de 32 bytes se deriva con HKDF-SHA256 donde se cifra (F3)
  APP_ENCRYPTION_KEY: requiredText.min(
    MIN_ENCRYPTION_KEY_LENGTH,
    `debe tener al menos ${MIN_ENCRYPTION_KEY_LENGTH} caracteres`,
  ),

  // IA (F2)
  LLM_PROVIDER: z
    .enum(LLM_PROVIDERS, { error: `debe ser ${listOf(LLM_PROVIDERS)}` })
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
 * Los valores se recortan y las variables vacías (`CLAVE=`) cuentan como no definidas.
 * Lanza `EnvError` con todos los problemas juntos.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const cleaned = Object.fromEntries(
    Object.entries(source)
      .map(([name, value]) => [name, value?.trim()] as const)
      .filter(([, value]) => value !== undefined && value !== ""),
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
