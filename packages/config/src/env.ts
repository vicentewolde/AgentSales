import {
  LLM_PROVIDERS,
  MERCADOLIBRE_SITE_ID,
  PUBLISH_MODES,
  WORKER_CHECK_PERIOD_MINUTES,
  WORKER_STAY_AHEAD_DEFAULT_MINUTES,
} from "@agentsales/core";
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

/**
 * La dirección pública del sistema (spec F8 §4.2): solo el origen (`https://host[:puerto]`), sin
 * ruta, barra final, consulta, fragmento, usuario ni clave. De ella salen los hosts y orígenes
 * permitidos, el panel y las direcciones de retorno de los OAuth.
 */
const publicUrl = z.string().superRefine((value, ctx) => {
  const url = URL.parse(value);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    ctx.addIssue({ code: "custom", message: "debe ser una URL https://" });
    return;
  }
  if (value !== url.origin) {
    ctx.addIssue({
      code: "custom",
      message: "debe ser solo el origen (https://host), sin ruta, barra final, consulta ni usuario",
    });
  }
});

/** Un nombre de host o una IP para escuchar (`127.0.0.1`, `0.0.0.0`, `::`). */
const listenHost = z
  .string()
  .regex(/^[A-Za-z0-9.:-]+$/, "debe ser un host o una IP (por ejemplo 127.0.0.1 o 0.0.0.0)");

/** El nombre de una cabecera HTTP (la de la IP del cliente que pone el proxy, spec F8 §4.2). */
const headerName = z
  .string()
  .regex(/^[A-Za-z0-9-]+$/, "debe ser el nombre de una cabecera (por ejemplo Fly-Client-IP)");

/** El prefijo de la API en el servidor (spec F8 §4.3, ADR-0024): las vueltas de los OAuth lo llevan. */
const API_PREFIX = "/api";

/**
 * La dirección de retorno de Mercado Libre en desarrollo: la registrada en la app (comparación
 * exacta). `.test` nunca resuelve: el operador copia la dirección de la barra (spec F4 §4.2).
 */
const DEV_ML_REDIRECT_URI = "https://agentsales.test/oauth/mercadolibre/callback";

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

/**
 * Dónde se guardan los respaldos de la base por defecto (spec F6 §4.11): fuera del proyecto, porque
 * traen datos de clientes y tokens cifrados.
 */
export const DEFAULT_BACKUP_DIR = "~/.agentsales/backups";

/** Una ruta absoluta o que empieza con `~/` (la resuelve `resolveBackupDir`, fuera del proyecto). */
const backupDir = z
  .string()
  .refine(
    (value) => value.startsWith("/") || value.startsWith("~/"),
    "debe ser una ruta absoluta o empezar con ~/, fuera del proyecto (los respaldos traen datos de clientes)",
  );

/**
 * Dónde queda el respaldo diario del worker (spec F8 §4.9, D13): `local` en `BACKUP_DIR` (F6) o `r2`
 * en un bucket aparte, con su propio token. En producción, `r2`.
 */
export const BACKUP_TARGETS = ["local", "r2"] as const;

/**
 * Las variables del token del bucket de respaldos: solo las usa el worker. La API las quita al
 * arrancar (`withoutBackupCredentials`), porque en Fly los secretos llegan a los dos procesos.
 */
export const BACKUP_CREDENTIAL_VARIABLES = [
  "BACKUP_R2_ACCESS_KEY_ID",
  "BACKUP_R2_SECRET_ACCESS_KEY",
] as const;

/** La carpeta de `pg_dump` y `pg_restore` (por ejemplo `/opt/homebrew/opt/libpq/bin`): absoluta. */
const pgBinDir = z.string().refine((value) => value.startsWith("/"), "debe ser una ruta absoluta");

/**
 * El valor que traía `.env.example` hasta F7 para la vuelta de Instagram, sin el prefijo `/api`
 * (spec F8 §4.3): se ignora y se usa el nuevo valor por defecto (ver `loadEnv`).
 */
const LEGACY_INSTAGRAM_REDIRECT_URI = "http://localhost:8787/oauth/instagram/callback";

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
    // Dónde escucha la API: `127.0.0.1` en el Mac; en producción, explícito (`0.0.0.0` detrás del
    // proxy del proveedor, spec F8 §4.2).
    API_HOST: listenHost.default("127.0.0.1"),
    // La dirección pública (obligatoria y `https://` en producción) y la cabecera con la IP del
    // cliente que pone el proxy (solo para los límites por IP; sin ella, la del socket).
    PUBLIC_URL: publicUrl.optional(),
    CLIENT_IP_HEADER: headerName.optional(),
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
    // La API de Anthropic: obligatoria con LLM_PROVIDER=anthropic-api (se exige abajo) y, desde
    // F7, la de los corredores que no son del operador (spec F7 §4.7). La CLI de Claude nunca la
    // recibe: con ella en su entorno cobraría por API en vez de usar el plan del operador.
    ANTHROPIC_API_KEY: z.string().optional(),
    // El modelo de la API (spec F7, D15); `LLM_MODEL` sigue siendo solo de la CLI de Claude.
    ANTHROPIC_MODEL: z.string().trim().min(1).default("claude-sonnet-5-5"),
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
    // Tope de cada archivo de una carga subida directo a R2 (spec F8 §4.4): el zip de medios (que
    // además no pasa de 4 GB) y cada archivo de una carpeta. El worker los baja a su disco: en el
    // servidor se fija con el disco que ofrezca el proveedor.
    MAX_IMPORT_UPLOAD_MB: positiveInt("un número entero de MB mayor que 0").default(512),
    // ffmpeg 8.1 o más nuevo (fotos HEIC) y ffprobe (videos), spec F2 §4.8.
    FFMPEG_PATH: z.string().default("ffmpeg"),
    FFPROBE_PATH: z.string().default("ffprobe"),

    // Instagram (F3): el par de la app de Instagram (Casos de uso > Personalizar > Configuración de
    // la API con el inicio de sesión de Instagram), no el de Configuración > Información básica.
    INSTAGRAM_APP_ID: z.string().optional(),
    INSTAGRAM_APP_SECRET: z.string().optional(),
    // La clave de la app de Meta (Configuración > Información básica), solo para verificar las
    // vueltas de Meta (F8-T17): cuál de las dos firma con Instagram Login no está verificado, así
    // que se acepta la firma de cualquiera (nota de Instagram §13.4). Opcional.
    FACEBOOK_APP_SECRET: z.string().optional(),
    // Sin valor: `<PUBLIC_URL>/api/oauth/instagram/callback`, o la API local (ver abajo).
    INSTAGRAM_REDIRECT_URI: httpUrl.optional(),

    // Mercado Libre / Portal Inmobiliario (F4): la app de developers.mercadolibre.cl. La dirección
    // de retorno es la misma registrada en la app (comparación exacta) y no necesita cargar: el
    // operador copia la dirección de la barra y la pega en la CLI (spec F4 §4.2). El panel de
    // Mercado Libre rechaza `https://localhost`; `.test` es un dominio reservado que nunca resuelve,
    // así que el código no llega a ningún servidor ajeno (nota de Mercado Libre §3.3).
    ML_APP_ID: z.string().optional(),
    ML_CLIENT_SECRET: z.string().optional(),
    // Sin valor: `<PUBLIC_URL>/api/oauth/mercadolibre/callback`, o `.test` en desarrollo (ver abajo).
    ML_REDIRECT_URI: mercadoLibreRedirectUri.optional(),

    // X (F9-T16): el par OAuth 2.0 de la app (cliente confidencial, "Web App") de console.x.com. La
    // dirección de retorno se registra igual en la app; en el Mac, X pide `127.0.0.1` y no
    // `localhost` (`docs/integraciones/x.md` §3.1). Sin valor: `<PUBLIC_URL>/api/oauth/x/callback`,
    // o `http://127.0.0.1:<API_PORT>/api/oauth/x/callback` en desarrollo.
    X_CLIENT_ID: z.string().optional(),
    X_CLIENT_SECRET: z.string().optional(),
    X_REDIRECT_URI: httpUrl.optional(),
    // LinkedIn (F9-T15, spec F9 §4.7): el par de la app de linkedin.com/developers (productos Share on
    // LinkedIn y Sign In with LinkedIn using OpenID Connect). La dirección de retorno es la misma
    // registrada en la pestaña Auth (comparación exacta). Si `http://localhost` se acepta: NO
    // VERIFICADO (`linkedin.md` §3.3); en el servidor es la de `PUBLIC_URL`.
    LINKEDIN_CLIENT_ID: z.string().optional(),
    LINKEDIN_CLIENT_SECRET: z.string().optional(),
    // Sin valor: `<PUBLIC_URL>/api/oauth/linkedin/callback`, o la API local (ver abajo).
    LINKEDIN_REDIRECT_URI: httpUrl.optional(),

    // TikTok (F9-T26): la app de developers.tiktok.com con Login Kit y Content Posting API (modo
    // Upload, `video.upload`). Sin el par, conectar responde TIKTOK_NOT_CONFIGURED y el token no
    // se renueva. La dirección de retorno es la registrada en la app (https; si acepta
    // `https://localhost` es parte de la prueba S6). Sin valor: `<PUBLIC_URL>/api/oauth/tiktok/callback`,
    // o la API local.
    TIKTOK_CLIENT_KEY: z.string().optional(),
    TIKTOK_CLIENT_SECRET: z.string().optional(),
    TIKTOK_REDIRECT_URI: httpUrl.optional(),

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

    // El worker se apaga solo (F9.5-T24, ADR-0037): tras estos minutos seguidos sin jobs activos ni
    // nada programado que venza en los próximos WORKER_STAY_AHEAD_MINUTES, cierra limpio (exit 0) y
    // la máquina queda detenida hasta la próxima revisión del horario (cada hora a los :50). Vacía
    // o 0: nunca se apaga solo (como antes). Mira por lo menos el periodo de la revisión (60 min): por
    // defecto 70, la próxima revisión y su atraso en GitHub (core, `worker-schedule.ts`).
    WORKER_IDLE_EXIT_MINUTES: intInRange(
      0,
      1440,
      "debe ser un número entero de minutos entre 0 (nunca) y 1440",
    ).default(0),
    WORKER_STAY_AHEAD_MINUTES: intInRange(
      WORKER_CHECK_PERIOD_MINUTES,
      1440,
      `debe ser un número entero de minutos entre ${WORKER_CHECK_PERIOD_MINUTES} (cada cuánto revisa el horario) y 1440`,
    ).default(WORKER_STAY_AHEAD_DEFAULT_MINUTES),

    // Respaldo local (F6, spec §4.11): la carpeta de los volcados (fuera del proyecto) y, opcional,
    // la de `pg_dump` y `pg_restore` (Homebrew `libpq` no queda en el PATH: sin esto se busca en el
    // PATH y en `/opt/homebrew/opt/libpq/bin`).
    BACKUP_DIR: backupDir.default(DEFAULT_BACKUP_DIR),
    PG_BIN_DIR: pgBinDir.optional(),
    // Respaldo en la nube (F8-T13, spec §4.9, D13): con `r2`, el worker sube el volcado a otro bucket
    // de la misma cuenta (R2_ACCOUNT_ID) con un token limitado a él; el estado va al bucket principal.
    // `pnpm db:backup` respalda siempre a BACKUP_DIR, diga lo que diga esta variable.
    BACKUP_TARGET: z.enum(BACKUP_TARGETS, { error: 'debe ser "local" o "r2"' }).default("local"),
    BACKUP_R2_BUCKET: z.string().optional(),
    BACKUP_R2_ACCESS_KEY_ID: z.string().optional(),
    BACKUP_R2_SECRET_ACCESS_KEY: z.string().optional(),
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
    if (env.BACKUP_TARGET === "r2") backupIssues(env, ctx);
    if (env.NODE_ENV === "production") productionIssues(env, ctx);
  })
  .transform((env) => ({
    ...env,
    INSTAGRAM_REDIRECT_URI:
      env.INSTAGRAM_REDIRECT_URI ??
      (env.PUBLIC_URL === undefined
        ? `http://localhost:${env.API_PORT}${API_PREFIX}/oauth/instagram/callback`
        : `${env.PUBLIC_URL}${API_PREFIX}/oauth/instagram/callback`),
    ML_REDIRECT_URI:
      env.ML_REDIRECT_URI ??
      (env.PUBLIC_URL === undefined
        ? DEV_ML_REDIRECT_URI
        : `${env.PUBLIC_URL}${API_PREFIX}/oauth/mercadolibre/callback`),
    X_REDIRECT_URI:
      env.X_REDIRECT_URI ??
      (env.PUBLIC_URL === undefined
        ? `http://127.0.0.1:${env.API_PORT}${API_PREFIX}/oauth/x/callback`
        : `${env.PUBLIC_URL}${API_PREFIX}/oauth/x/callback`),
    LINKEDIN_REDIRECT_URI:
      env.LINKEDIN_REDIRECT_URI ??
      (env.PUBLIC_URL === undefined
        ? `http://localhost:${env.API_PORT}${API_PREFIX}/oauth/linkedin/callback`
        : `${env.PUBLIC_URL}${API_PREFIX}/oauth/linkedin/callback`),
    TIKTOK_REDIRECT_URI:
      env.TIKTOK_REDIRECT_URI ??
      (env.PUBLIC_URL === undefined
        ? `http://localhost:${env.API_PORT}${API_PREFIX}/oauth/tiktok/callback`
        : `${env.PUBLIC_URL}${API_PREFIX}/oauth/tiktok/callback`),
  }));

/** Lo que mira `backupIssues`: el respaldo a R2 necesita su bucket y su token, distintos de los de los medios. */
type BackupEnv = {
  R2_BUCKET: string;
  R2_ACCESS_KEY_ID: string;
  BACKUP_R2_BUCKET?: string | undefined;
  BACKUP_R2_ACCESS_KEY_ID?: string | undefined;
  BACKUP_R2_SECRET_ACCESS_KEY?: string | undefined;
};

/**
 * Con `BACKUP_TARGET=r2` (spec F8 §4.9): el bucket y el token de respaldos son obligatorios y otros
 * que los de los medios (así la API, que tiene el token de los medios, no puede leer ni borrar los
 * respaldos, y un token filtrado de los respaldos no toca los medios).
 */
function backupIssues(env: BackupEnv, ctx: z.RefinementCtx): void {
  for (const variable of [
    "BACKUP_R2_BUCKET",
    "BACKUP_R2_ACCESS_KEY_ID",
    "BACKUP_R2_SECRET_ACCESS_KEY",
  ] as const) {
    if (env[variable] === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [variable],
        message: 'falta (obligatoria con BACKUP_TARGET="r2")',
      });
    }
  }
  if (env.BACKUP_R2_BUCKET !== undefined && env.BACKUP_R2_BUCKET === env.R2_BUCKET) {
    ctx.addIssue({
      code: "custom",
      path: ["BACKUP_R2_BUCKET"],
      message: "debe ser otro bucket que R2_BUCKET (por ejemplo agentsales-backups)",
    });
  }
  if (
    env.BACKUP_R2_ACCESS_KEY_ID !== undefined &&
    env.BACKUP_R2_ACCESS_KEY_ID === env.R2_ACCESS_KEY_ID
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["BACKUP_R2_ACCESS_KEY_ID"],
      message:
        "debe ser otro token que el de R2_ACCESS_KEY_ID (uno limitado al bucket de respaldos)",
    });
  }
}

/** Lo que mira `productionIssues` del entorno ya validado (antes de los valores derivados). */
type ParsedEnv = {
  LLM_PROVIDER: string;
  BACKUP_TARGET: string;
  PUBLIC_URL?: string | undefined;
  INSTAGRAM_REDIRECT_URI?: string | undefined;
  ML_REDIRECT_URI?: string | undefined;
  X_REDIRECT_URI?: string | undefined;
  LINKEDIN_REDIRECT_URI?: string | undefined;
  TIKTOK_REDIRECT_URI?: string | undefined;
};

/**
 * Lo que exige `NODE_ENV=production` (spec F8 §4.2): `PUBLIC_URL` con `https://`, las direcciones de
 * retorno dentro de ella y la API de Anthropic como IA (el plan Max es solo para uso propio, no para
 * un servidor que atiende a terceros: `docs/integraciones/anthropic-terminos.md` §6), y el respaldo a
 * R2 (`BACKUP_TARGET=r2`, D13: el disco de la máquina no dura). `API_HOST` explícito lo revisa
 * `loadEnv`, que ve el entorno sin los valores por defecto, igual que `BROWSER_PROFILES_DIR`: el
 * formulario automático de Marketplace no corre en producción (F8-T20, D4), así que no hay carpeta de
 * perfiles que configurar.
 */
function productionIssues(env: ParsedEnv, ctx: z.RefinementCtx): void {
  if (env.PUBLIC_URL === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["PUBLIC_URL"],
      message: "falta (obligatoria con NODE_ENV=production)",
    });
  } else if (!env.PUBLIC_URL.startsWith("https://")) {
    ctx.addIssue({
      code: "custom",
      path: ["PUBLIC_URL"],
      message: "debe ser https:// con NODE_ENV=production",
    });
  } else {
    for (const variable of [
      "INSTAGRAM_REDIRECT_URI",
      "ML_REDIRECT_URI",
      "X_REDIRECT_URI",
      "LINKEDIN_REDIRECT_URI",
      "TIKTOK_REDIRECT_URI",
    ] as const) {
      const value = env[variable];
      if (value !== undefined && !value.startsWith(`${env.PUBLIC_URL}/`)) {
        ctx.addIssue({
          code: "custom",
          path: [variable],
          message: "debe empezar con PUBLIC_URL con NODE_ENV=production",
        });
      }
    }
  }
  // Ni la CLI de Claude ni la IA de mentira (`fake` redactaría textos inventados sin avisar).
  if (env.LLM_PROVIDER !== "anthropic-api") {
    ctx.addIssue({
      code: "custom",
      path: ["LLM_PROVIDER"],
      message:
        'debe ser "anthropic-api" con NODE_ENV=production (el plan de Claude es solo para uso propio)',
    });
  }
  if (env.BACKUP_TARGET !== "r2") {
    ctx.addIssue({
      code: "custom",
      path: ["BACKUP_TARGET"],
      message:
        'debe ser "r2" con NODE_ENV=production (el disco del servidor no guarda los respaldos)',
    });
  }
}

export type Env = Readonly<z.output<typeof envSchema>>;

export type EnvIssue = { variable: string; message: string };

/** Error de configuración. El mensaje nombra las variables con problemas, nunca sus valores. */
export class EnvError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    const lines = issues.map((issue) => `  - ${issue.variable}: ${issue.message}`);
    super(
      `Configuración inválida en el archivo de entorno (ver .env.example):\n${lines.join("\n")}`,
    );
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
  // La vuelta de Instagram del ejemplo de antes no lleva `/api`: su inicio daría 404 (spec F8 §4.3).
  if (cleaned.INSTAGRAM_REDIRECT_URI === LEGACY_INSTAGRAM_REDIRECT_URI) {
    delete cleaned.INSTAGRAM_REDIRECT_URI;
  }
  // En producción, dónde escucha la API no se deja al valor por defecto (spec F8 §4.2).
  if (cleaned.NODE_ENV === "production" && cleaned.API_HOST === undefined) {
    outdated.push({
      variable: "API_HOST",
      message: "falta (obligatoria con NODE_ENV=production; por ejemplo 0.0.0.0)",
    });
  }
  // Detrás del proxy, sin la cabecera de la IP todos los clientes comparten la del proxy y los
  // límites por IP (F8-T14) frenarían a todos juntos.
  if (cleaned.NODE_ENV === "production" && cleaned.CLIENT_IP_HEADER === undefined) {
    outdated.push({
      variable: "CLIENT_IP_HEADER",
      message: "falta (obligatoria con NODE_ENV=production; en Fly, Fly-Client-IP)",
    });
  }
  // El formulario automático de Marketplace no corre en producción (spec F8 §4.10, D4): sin
  // perfiles del navegador en el servidor, la carpeta no se configura.
  if (cleaned.NODE_ENV === "production" && cleaned.BROWSER_PROFILES_DIR !== undefined) {
    outdated.push({
      variable: "BROWSER_PROFILES_DIR",
      message:
        "no va con NODE_ENV=production (el formulario automático de Marketplace no corre en el servidor): quítala",
    });
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

/**
 * La dirección del panel (los enlaces de invitación y la vuelta de los OAuth, spec F8 §4.2):
 * `PUBLIC_URL` en el servidor, o el panel de Vite en el Mac.
 */
export function panelUrlOf(env: Pick<Env, "PUBLIC_URL" | "WEB_PORT">): string {
  return env.PUBLIC_URL ?? `http://localhost:${env.WEB_PORT}`;
}

/**
 * Si el ambiente permite el formulario automático de Marketplace (el perfil del navegador, spec F8
 * §4.10, D4): en todos menos en producción, donde Marketplace se publica a mano. La API y el worker
 * se lo pasan a core (`marketplaceAutomation`), que no lee el entorno.
 */
export function marketplaceAutomationEnabled(env: Pick<Env, "NODE_ENV">): boolean {
  return env.NODE_ENV !== "production";
}

/** El bucket de respaldos y su token (spec F8 §4.9); la cuenta es la de `R2_ACCOUNT_ID`. */
export type BackupStorageConfig = { bucket: string; accessKeyId: string; secretAccessKey: string };

/**
 * El bucket de respaldos con `BACKUP_TARGET=r2`, o `null` con `local` (o si a la configuración le
 * quitaron el token: la de la API, `withoutBackupCredentials`). `loadEnv` ya exige los tres con `r2`.
 */
export function backupStorageOf(
  env: Pick<
    Env,
    "BACKUP_TARGET" | "BACKUP_R2_BUCKET" | "BACKUP_R2_ACCESS_KEY_ID" | "BACKUP_R2_SECRET_ACCESS_KEY"
  >,
): BackupStorageConfig | null {
  if (
    env.BACKUP_TARGET !== "r2" ||
    env.BACKUP_R2_BUCKET === undefined ||
    env.BACKUP_R2_ACCESS_KEY_ID === undefined ||
    env.BACKUP_R2_SECRET_ACCESS_KEY === undefined
  ) {
    return null;
  }
  return {
    bucket: env.BACKUP_R2_BUCKET,
    accessKeyId: env.BACKUP_R2_ACCESS_KEY_ID,
    secretAccessKey: env.BACKUP_R2_SECRET_ACCESS_KEY,
  };
}

/**
 * La configuración de la API, sin el token de respaldos (spec F8 §4.9, D13: solo lo tiene el
 * worker). En Fly los secretos de la app llegan a los dos procesos; la API los quita de su entorno al
 * arrancar (así tampoco los hereda un proceso hijo) y de su configuración. Devuelve otra
 * configuración, inmutable; `BACKUP_TARGET` y el bucket quedan (la API lee el estado, no los volcados).
 */
export function withoutBackupCredentials(
  env: Env,
  processEnv: Record<string, string | undefined> = process.env,
): Env {
  for (const variable of BACKUP_CREDENTIAL_VARIABLES) delete processEnv[variable];
  return Object.freeze({
    ...env,
    BACKUP_R2_ACCESS_KEY_ID: undefined,
    BACKUP_R2_SECRET_ACCESS_KEY: undefined,
  });
}
