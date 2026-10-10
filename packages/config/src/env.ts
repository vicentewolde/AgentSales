import { LLM_PROVIDERS, MERCADOLIBRE_SITE_ID, PUBLISH_MODES } from "@agentsales/core";
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

/** URL `http://` o `https://` (la dirección de retorno del OAuth). */
const httpUrl = z.string().refine((value) => {
  const url = URL.parse(value);
  return url !== null && (url.protocol === "http:" || url.protocol === "https:");
}, "debe ser una URL http:// o https://");

/**
 * Dirección de retorno de Mercado Libre (spec F4 §4.2): solo `https://`, y sin usuario, clave ni
 * fragmento. Mercado Libre la compara exacta (un `#` rompe el canje), y `doctor` la muestra.
 */
const mercadoLibreRedirectUri = z.string().superRefine((value, ctx) => {
  const url = URL.parse(value);
  if (url?.protocol !== "https:") {
    ctx.addIssue({ code: "custom", message: "debe ser una URL https://" });
    return;
  }
  if (url.username !== "" || url.password !== "" || value.includes("#")) {
    ctx.addIssue({ code: "custom", message: "no debe llevar usuario, clave ni fragmento (#)" });
  }
});

// Variables obsoletas: una que cambiaría el comportamiento se avisa en vez de ignorarla en silencio.

/**
 * Dónde viven los perfiles del navegador de Marketplace por defecto: fuera del proyecto, para que
 * ni git ni una herramienta que lea el proyecto vea la sesión de Facebook (spec F5 §4.2).
 */
export const DEFAULT_BROWSER_PROFILES_DIR = "~/.agentsales/browser-profiles";

/** El valor que traía `.env.example` hasta F5 (dentro del proyecto): se ignora (ver `loadEnv`). */
const LEGACY_BROWSER_PROFILES_DIR = "./.browser-profiles";

/** Una ruta absoluta o que empieza con `~/`: una relativa quedaría dentro del proyecto. */
const browserProfilesDir = z
  .string()
  .refine(
    (value) => value.startsWith("/") || value.startsWith("~/"),
    "debe ser una ruta absoluta o empezar con ~/, fuera del proyecto (guarda la sesión de Facebook)",
  );

/** Variables que cambiaron de nombre (spec F3, D5). */
const RENAMED_VARIABLES: Readonly<Record<string, string>> = {
  META_APP_ID: "INSTAGRAM_APP_ID",
  META_APP_SECRET: "INSTAGRAM_APP_SECRET",
  META_REDIRECT_URI: "INSTAGRAM_REDIRECT_URI",
};

/**
 * `ML_SITE_ID` ya no se usa: el sitio es fijo (`MERCADOLIBRE_SITE_ID`, spec F4 §4.2). Con `MLC`, el
 * valor que traía `.env.example`, se ignora; con otro es un error, porque se publicaría igual en Chile.
 */
function removedSiteId(source: Record<string, string | undefined>): EnvIssue[] {
  const value = source.ML_SITE_ID;
  return value === undefined || value.toUpperCase() === MERCADOLIBRE_SITE_ID
    ? []
    : [
        {
          variable: "ML_SITE_ID",
          message: `ya no se usa: el sitio es fijo (${MERCADOLIBRE_SITE_ID}); quítala del .env`,
        },
      ];
}

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

const envSchema = z
  .object({
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

    // Seguridad: las claves de 32 bytes se derivan con HKDF-SHA256 por propósito (crypto.ts, F3)
    APP_ENCRYPTION_KEY: requiredText.min(
      MIN_ENCRYPTION_KEY_LENGTH,
      `debe tener al menos ${MIN_ENCRYPTION_KEY_LENGTH} caracteres`,
    ),

    // IA (F2)
    LLM_PROVIDER: z
      .enum(LLM_PROVIDERS, { error: `debe ser ${listOf(LLM_PROVIDERS)}` })
      .default("claude-cli"),
    LLM_MODEL: z.string().default("sonnet"),
    // Solo con LLM_PROVIDER=anthropic-api (se exige abajo). La CLI de Claude nunca la recibe: con
    // ella en su entorno cobraría por API en vez de usar el plan del operador (spec F2 §4.5).
    ANTHROPIC_API_KEY: z.string().optional(),
    // Ejecutable de la CLI de Claude (proveedor claude-cli) y tope de cada llamada a la IA. Hasta
    // 600 s: la llamada y su reintento, más los medios, deben caber en los 30 min del job.
    CLAUDE_CLI_PATH: z.string().default("claude"),
    LLM_TIMEOUT_SECONDS: intInRange(
      10,
      600,
      "debe ser un número entero de segundos entre 10 y 600",
    ).default(180),

    // Medios (F1-F2)
    MAX_VIDEO_MB: positiveInt("un número entero de MB mayor que 0").default(300),
    // Tope del cuerpo de `POST /imports` (xlsx + zip). Hono lo lee completo en memoria y la subida
    // puede ocupar hasta ~2 veces eso mientras se procesa (spec F1 §4.4).
    MAX_IMPORT_UPLOAD_MB: positiveInt("un número entero de MB mayor que 0").default(512),
    // ffmpeg 8.1 o más nuevo (fotos HEIC) y ffprobe (videos), spec F2 §4.8.
    FFMPEG_PATH: z.string().default("ffmpeg"),
    FFPROBE_PATH: z.string().default("ffprobe"),

    // Instagram (F3): el par de la app de Instagram (Casos de uso > Personalizar > Configuración de
    // la API con el inicio de sesión de Instagram), no el de Configuración > Información básica.
    INSTAGRAM_APP_ID: z.string().optional(),
    INSTAGRAM_APP_SECRET: z.string().optional(),
    INSTAGRAM_REDIRECT_URI: httpUrl.default("http://localhost:8787/oauth/instagram/callback"),

    // Mercado Libre / Portal Inmobiliario (F4): la app de developers.mercadolibre.cl. La dirección
    // de retorno es la misma registrada en la app (comparación exacta) y no necesita cargar: el
    // operador copia la dirección de la barra y la pega en la CLI (spec F4 §4.2). El panel de
    // Mercado Libre rechaza `https://localhost`; `.test` es un dominio reservado que nunca resuelve,
    // así que el código no llega a ningún servidor ajeno (nota de Mercado Libre §3.3).
    ML_APP_ID: z.string().optional(),
    ML_CLIENT_SECRET: z.string().optional(),
    ML_REDIRECT_URI: mercadoLibreRedirectUri.default(
      "https://agentsales.test/oauth/mercadolibre/callback",
    ),

    // Facebook Marketplace (F5): avisos por día y cuenta (D8), la carpeta de los perfiles del
    // navegador (fuera del proyecto: guardan la sesión de Facebook, ADR-0017; la resuelve
    // `resolveBrowserProfilesDir`) y cuánto espera la ventana el clic del operador (spec F5 §4.5).
    MARKETPLACE_DAILY_LIMIT: positiveInt("un número entero mayor que 0").default(3),
    BROWSER_PROFILES_DIR: browserProfilesDir.default(DEFAULT_BROWSER_PROFILES_DIR),
    // El token de la API BDE del Banco Central (spec F5 §4.6, nota uf.md): sin él, un aviso en UF
    // no va a Marketplace (su precio se convierte a pesos con el valor del día).
    BCCH_API_TOKEN: z.string().optional(),
    MARKETPLACE_CONFIRM_TIMEOUT_MIN: intInRange(
      1,
      240,
      "debe ser un número entero de minutos entre 1 y 240",
    ).default(30),
  })
  .superRefine((env, ctx) => {
    // El proveedor de la API de Anthropic no funciona sin su clave (deuda de F1, spec F2 §4.5).
    if (env.LLM_PROVIDER === "anthropic-api" && env.ANTHROPIC_API_KEY === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["ANTHROPIC_API_KEY"],
        message: 'falta (obligatoria con LLM_PROVIDER="anthropic-api")',
      });
    }
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
  const outdated: EnvIssue[] = [
    ...Object.entries(RENAMED_VARIABLES)
      .filter(([old]) => old in cleaned)
      .map(([old, current]) => ({ variable: old, message: `se renombró a ${current}` })),
    ...removedSiteId(cleaned),
  ];
  // El valor viejo de `.env.example` dejaba el perfil dentro del proyecto: se usa el nuevo default.
  if (cleaned.BROWSER_PROFILES_DIR === LEGACY_BROWSER_PROFILES_DIR) {
    delete cleaned.BROWSER_PROFILES_DIR;
  }
  const result = envSchema.safeParse(cleaned);
  if (!result.success || outdated.length > 0) {
    throw new EnvError([
      ...outdated,
      ...(result.success
        ? []
        : result.error.issues.map((issue) => ({
            variable: issue.path.join(".") || "(entorno)",
            message: issue.message,
          }))),
    ]);
  }
  return Object.freeze(result.data);
}
