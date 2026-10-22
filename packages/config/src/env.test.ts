import { describe, expect, it } from "vitest";
import {
  backupStorageOf,
  EnvError,
  loadEnv,
  marketplaceAutomationEnabled,
  panelUrlOf,
  withoutBackupCredentials,
} from "./env.js";

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
    ["ML_REDIRECT_URI", "http://SECRETVAL.test/cb"],
    ["ML_SITE_ID", "SECRETVAL"],
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
        INSTAGRAM_REDIRECT_URI: "http://localhost:8787/api/oauth/instagram/callback",
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

  describe("Mercado Libre (F4)", () => {
    it("lee el par de la app y usa la dirección de retorno https por defecto", () => {
      const env = loadEnv({ ...validSource, ML_APP_ID: "123", ML_CLIENT_SECRET: "fake-secret" });

      expect(env).toMatchObject({
        ML_APP_ID: "123",
        ML_CLIENT_SECRET: "fake-secret",
        ML_REDIRECT_URI: "https://agentsales.test/oauth/mercadolibre/callback",
      });
      expect(loadEnv(validSource).ML_APP_ID).toBeUndefined();
      expect(loadEnv({ ...validSource, ML_REDIRECT_URI: "" }).ML_REDIRECT_URI).toBe(
        "https://agentsales.test/oauth/mercadolibre/callback",
      );
    });

    it("acepta otra dirección https", () => {
      expect(
        loadEnv({ ...validSource, ML_REDIRECT_URI: "https://agentsales.test/ml/cb" })
          .ML_REDIRECT_URI,
      ).toBe("https://agentsales.test/ml/cb");
    });

    it.each([
      "http://localhost/oauth/mercadolibre/callback",
      "HTTP://localhost:8787/cb",
      "ftp://agentsales.test/cb",
      "localhost/oauth/mercadolibre/callback",
    ])("rechaza la dirección de retorno %s (Mercado Libre exige https)", (value) => {
      expect(envErrorOf({ ...validSource, ML_REDIRECT_URI: value }).issues).toEqual([
        { variable: "ML_REDIRECT_URI", message: "debe ser una URL https://" },
      ]);
    });

    it.each([
      "https://usuario:clave@localhost/oauth/mercadolibre/callback",
      "https://localhost/oauth/mercadolibre/callback#x",
      "https://localhost/oauth/mercadolibre/callback#",
    ])("rechaza la dirección de retorno con usuario, clave o fragmento (%s)", (value) => {
      const error = envErrorOf({ ...validSource, ML_REDIRECT_URI: value });

      expect(error.issues).toEqual([
        { variable: "ML_REDIRECT_URI", message: "no debe llevar usuario, clave ni fragmento (#)" },
      ]);
      expect(error.message).not.toContain("clave@");
    });

    it("ignora ML_SITE_ID con MLC, el valor del ejemplo, y no la devuelve", () => {
      for (const value of ["MLC", "mlc"]) {
        const env = loadEnv({ ...validSource, ML_SITE_ID: value });

        expect(env).not.toHaveProperty("ML_SITE_ID");
      }
    });

    it("rechaza ML_SITE_ID con otro sitio, junto con los demás problemas", () => {
      const error = envErrorOf({ ...validSource, ML_SITE_ID: "MLA", API_PORT: "abc" });

      expect(error.issues).toEqual([
        {
          variable: "ML_SITE_ID",
          message: "ya no se usa: el sitio es fijo (MLC); quítala del .env",
        },
        { variable: "API_PORT", message: "debe ser un puerto entre 1 y 65535" },
      ]);
    });
  });

  describe("Facebook Marketplace (F5)", () => {
    it("por defecto: 3 avisos al día, el perfil fuera del proyecto y 30 min de espera", () => {
      const env = loadEnv(validSource);

      expect(env.MARKETPLACE_DAILY_LIMIT).toBe(3);
      expect(env.BROWSER_PROFILES_DIR).toBe("~/.agentsales/browser-profiles");
      expect(env.MARKETPLACE_CONFIRM_TIMEOUT_MIN).toBe(30);
    });

    it("ignora el valor viejo de .env.example (dentro del proyecto) y usa el nuevo", () => {
      const env = loadEnv({ ...validSource, BROWSER_PROFILES_DIR: "./.browser-profiles" });

      expect(env.BROWSER_PROFILES_DIR).toBe("~/.agentsales/browser-profiles");
    });

    it("acepta una ruta absoluta o con ~/", () => {
      expect(
        loadEnv({ ...validSource, BROWSER_PROFILES_DIR: "/srv/perfiles" }).BROWSER_PROFILES_DIR,
      ).toBe("/srv/perfiles");
      expect(
        loadEnv({ ...validSource, BROWSER_PROFILES_DIR: "~/perfiles" }).BROWSER_PROFILES_DIR,
      ).toBe("~/perfiles");
    });

    it.each(["perfiles", "./tmp/perfiles", "../perfiles"])(
      "rechaza una ruta relativa (%s): quedaría dentro del proyecto",
      (value) => {
        const error = envErrorOf({ ...validSource, BROWSER_PROFILES_DIR: value });

        expect(error.issues.map((issue) => issue.variable)).toEqual(["BROWSER_PROFILES_DIR"]);
        expect(error.message).not.toContain(value);
      },
    );

    it.each(["0", "241", "abc"])("rechaza MARKETPLACE_CONFIRM_TIMEOUT_MIN=%s", (value) => {
      const error = envErrorOf({ ...validSource, MARKETPLACE_CONFIRM_TIMEOUT_MIN: value });

      expect(error.message).toContain(
        "MARKETPLACE_CONFIRM_TIMEOUT_MIN: debe ser un número entero de minutos entre 1 y 240",
      );
    });
  });

  describe("El worker se apaga solo (F9.5-T24)", () => {
    it("por defecto (o vacía) nunca se apaga: 0", () => {
      expect(loadEnv(validSource).WORKER_IDLE_EXIT_MINUTES).toBe(0);
      expect(
        loadEnv({ ...validSource, WORKER_IDLE_EXIT_MINUTES: "" }).WORKER_IDLE_EXIT_MINUTES,
      ).toBe(0);
    });

    it("acepta los minutos", () => {
      expect(
        loadEnv({ ...validSource, WORKER_IDLE_EXIT_MINUTES: "10" }).WORKER_IDLE_EXIT_MINUTES,
      ).toBe(10);
    });

    it.each(["-1", "diez", "1441", "2.5"])("rechaza %s", (value) => {
      const error = envErrorOf({ ...validSource, WORKER_IDLE_EXIT_MINUTES: value });

      expect(error.issues).toEqual([
        {
          variable: "WORKER_IDLE_EXIT_MINUTES",
          message: "debe ser un número entero de minutos entre 0 (nunca) y 1440",
        },
      ]);
    });
  });

  describe("Respaldo local (F6-T14)", () => {
    it("por defecto: la carpeta fuera del proyecto y sin PG_BIN_DIR", () => {
      const env = loadEnv(validSource);

      expect(env.BACKUP_DIR).toBe("~/.agentsales/backups");
      expect(env.PG_BIN_DIR).toBeUndefined();
    });

    it("acepta rutas absolutas", () => {
      const env = loadEnv({
        ...validSource,
        BACKUP_DIR: "/Volumes/Respaldo/agentsales",
        PG_BIN_DIR: "/opt/homebrew/opt/libpq/bin",
      });

      expect(env.BACKUP_DIR).toBe("/Volumes/Respaldo/agentsales");
      expect(env.PG_BIN_DIR).toBe("/opt/homebrew/opt/libpq/bin");
    });

    it.each([
      ["BACKUP_DIR", "carpeta-relativa"],
      ["BACKUP_DIR", "./tmp/copias"],
      ["PG_BIN_DIR", "libpq/bin"],
      ["PG_BIN_DIR", "~/libpq/bin"],
    ])("rechaza %s=%s (relativa)", (variable, value) => {
      const error = envErrorOf({ ...validSource, [variable]: value });

      expect(error.issues.map((issue) => issue.variable)).toEqual([variable]);
      expect(error.message).not.toContain(value);
    });
  });

  describe("En internet (F8-T01)", () => {
    const production = {
      ...validSource,
      NODE_ENV: "production",
      PUBLIC_URL: "https://agentsales.agentpey.com",
      API_HOST: "0.0.0.0",
      CLIENT_IP_HEADER: "Fly-Client-IP",
      LLM_PROVIDER: "anthropic-api",
      ANTHROPIC_API_KEY: "fake-anthropic-key",
      BACKUP_TARGET: "r2",
      BACKUP_R2_BUCKET: "agentsales-backups",
      BACKUP_R2_ACCESS_KEY_ID: "fake-backup-access-key",
      BACKUP_R2_SECRET_ACCESS_KEY: "fake-backup-secret",
    };

    it("en desarrollo no exige nada nuevo: escucha en 127.0.0.1 y las vueltas son locales", () => {
      const env = loadEnv(validSource);

      expect(env.API_HOST).toBe("127.0.0.1");
      expect(env.PUBLIC_URL).toBeUndefined();
      expect(env.CLIENT_IP_HEADER).toBeUndefined();
      expect(env.INSTAGRAM_REDIRECT_URI).toBe("http://localhost:8787/api/oauth/instagram/callback");
      expect(env.ML_REDIRECT_URI).toBe("https://agentsales.test/oauth/mercadolibre/callback");
      expect(loadEnv({ ...validSource, API_PORT: "9000" }).INSTAGRAM_REDIRECT_URI).toBe(
        "http://localhost:9000/api/oauth/instagram/callback",
      );
    });

    it("una producción completa: las vueltas salen de PUBLIC_URL, bajo /api", () => {
      const env = loadEnv({ ...production, CLIENT_IP_HEADER: "Fly-Client-IP" });

      expect(env).toMatchObject({
        NODE_ENV: "production",
        PUBLIC_URL: "https://agentsales.agentpey.com",
        API_HOST: "0.0.0.0",
        CLIENT_IP_HEADER: "Fly-Client-IP",
        INSTAGRAM_REDIRECT_URI: "https://agentsales.agentpey.com/api/oauth/instagram/callback",
        ML_REDIRECT_URI: "https://agentsales.agentpey.com/api/oauth/mercadolibre/callback",
      });
    });

    it("producción sin PUBLIC_URL, con http:// o sin API_HOST se rechaza", () => {
      expect(envErrorOf({ ...production, PUBLIC_URL: undefined }).issues).toEqual([
        { variable: "PUBLIC_URL", message: "falta (obligatoria con NODE_ENV=production)" },
      ]);
      expect(
        envErrorOf({ ...production, PUBLIC_URL: "http://agentsales.agentpey.com" }).issues,
      ).toEqual([{ variable: "PUBLIC_URL", message: "debe ser https:// con NODE_ENV=production" }]);
      expect(
        envErrorOf({ ...production, API_HOST: undefined }).issues.map((i) => i.variable),
      ).toEqual(["API_HOST"]);
      // Sin la cabecera de la IP, los límites por IP (F8-T14) frenarían a todos juntos.
      expect(
        envErrorOf({ ...production, CLIENT_IP_HEADER: undefined }).issues.map((i) => i.variable),
      ).toEqual(["CLIENT_IP_HEADER"]);
    });

    it.each([
      ["con ruta", "https://agentpey.com/agentsales"],
      ["con barra final", "https://agentsales.agentpey.com/"],
      ["con consulta", "https://agentsales.agentpey.com?x=1"],
      ["con usuario", "https://yo@agentsales.agentpey.com"],
      ["sin protocolo web", "ftp://agentsales.agentpey.com"],
      ["que no es URL", "agentsales"],
    ])("PUBLIC_URL %s se rechaza, sin mostrar el valor", (_case, value) => {
      const error = envErrorOf({ ...validSource, PUBLIC_URL: value });

      expect(error.issues.map((issue) => issue.variable)).toEqual(["PUBLIC_URL"]);
      expect(error.message).not.toContain(value);
    });

    it("en producción una dirección de retorno de otro host se rechaza", () => {
      const error = envErrorOf({
        ...production,
        INSTAGRAM_REDIRECT_URI: "https://otro.example/api/oauth/instagram/callback",
        ML_REDIRECT_URI: "https://agentsales.test/oauth/mercadolibre/callback",
      });

      expect(error.issues).toEqual([
        {
          variable: "INSTAGRAM_REDIRECT_URI",
          message: "debe empezar con PUBLIC_URL con NODE_ENV=production",
        },
        {
          variable: "ML_REDIRECT_URI",
          message: "debe empezar con PUBLIC_URL con NODE_ENV=production",
        },
      ]);
    });

    it("TikTok (F9-T26): la vuelta sale de PUBLIC_URL o de la API local, y en producción debe ser del mismo host", () => {
      expect(loadEnv(validSource).TIKTOK_REDIRECT_URI).toBe(
        "http://localhost:8787/api/oauth/tiktok/callback",
      );
      expect(
        loadEnv({ ...production, CLIENT_IP_HEADER: "Fly-Client-IP" }).TIKTOK_REDIRECT_URI,
      ).toBe("https://agentsales.agentpey.com/api/oauth/tiktok/callback");
      expect(
        envErrorOf({
          ...production,
          CLIENT_IP_HEADER: "Fly-Client-IP",
          TIKTOK_REDIRECT_URI: "https://otro.example/api/oauth/tiktok/callback",
        }).issues,
      ).toEqual([
        {
          variable: "TIKTOK_REDIRECT_URI",
          message: "debe empezar con PUBLIC_URL con NODE_ENV=production",
        },
      ]);
    });

    it("en producción BROWSER_PROFILES_DIR se rechaza (el formulario automático no corre allí, F8-T20)", () => {
      const error = envErrorOf({ ...production, BROWSER_PROFILES_DIR: "/data/perfiles" });

      expect(error.issues).toEqual([
        {
          variable: "BROWSER_PROFILES_DIR",
          message: expect.stringContaining("no va con NODE_ENV=production"),
        },
      ]);
      expect(error.message).not.toContain("/data/perfiles");
      // Sin ella, producción carga (el valor por defecto no se usa: no hay perfiles).
      expect(() => loadEnv(production)).not.toThrow();
      // En desarrollo sigue configurable.
      expect(
        loadEnv({ ...validSource, BROWSER_PROFILES_DIR: "/data/perfiles" }).BROWSER_PROFILES_DIR,
      ).toBe("/data/perfiles");
    });

    it("marketplaceAutomationEnabled: el formulario automático corre en todo menos en producción", () => {
      expect(marketplaceAutomationEnabled(loadEnv(validSource))).toBe(true);
      expect(marketplaceAutomationEnabled(loadEnv({ ...validSource, NODE_ENV: "test" }))).toBe(
        true,
      );
      expect(marketplaceAutomationEnabled(loadEnv(production))).toBe(false);
    });

    it("la CLI de Claude no corre en producción (también por defecto)", () => {
      const { LLM_PROVIDER: _provider, ...withoutProvider } = production;

      for (const source of [withoutProvider, { ...production, LLM_PROVIDER: "claude-cli" }]) {
        expect(envErrorOf(source).issues.map((issue) => issue.variable)).toEqual(["LLM_PROVIDER"]);
      }
      // Tampoco la IA de mentira: redactaría textos inventados sin avisar.
      expect(
        envErrorOf({ ...production, LLM_PROVIDER: "fake" }).issues.map((i) => i.variable),
      ).toEqual(["LLM_PROVIDER"]);
    });

    it("el respaldo es local por defecto; en producción debe ir a R2", () => {
      const env = loadEnv(validSource);
      expect(env.BACKUP_TARGET).toBe("local");
      expect(backupStorageOf(env)).toBeNull();

      for (const target of [undefined, "local"]) {
        expect(
          envErrorOf({ ...production, BACKUP_TARGET: target }).issues.map((i) => i.variable),
        ).toEqual(["BACKUP_TARGET"]);
      }
      expect(envErrorOf({ ...validSource, BACKUP_TARGET: "s3" }).issues).toEqual([
        { variable: "BACKUP_TARGET", message: 'debe ser "local" o "r2"' },
      ]);
    });

    it("con BACKUP_TARGET=r2: el bucket y el token de respaldos, otros que los de los medios", () => {
      expect(backupStorageOf(loadEnv(production))).toEqual({
        bucket: "agentsales-backups",
        accessKeyId: "fake-backup-access-key",
        secretAccessKey: "fake-backup-secret",
      });
      // También en desarrollo, si el operador lo pide en su archivo de entorno.
      expect(envErrorOf({ ...validSource, BACKUP_TARGET: "r2" }).issues).toEqual(
        ["BACKUP_R2_BUCKET", "BACKUP_R2_ACCESS_KEY_ID", "BACKUP_R2_SECRET_ACCESS_KEY"].map(
          (variable) => ({ variable, message: 'falta (obligatoria con BACKUP_TARGET="r2")' }),
        ),
      );
      const sameAsMedia = envErrorOf({
        ...production,
        BACKUP_R2_BUCKET: validSource.R2_BUCKET,
        BACKUP_R2_ACCESS_KEY_ID: validSource.R2_ACCESS_KEY_ID,
      });
      expect(sameAsMedia.issues.map((issue) => issue.variable)).toEqual([
        "BACKUP_R2_BUCKET",
        "BACKUP_R2_ACCESS_KEY_ID",
      ]);
      expect(sameAsMedia.message).not.toContain(validSource.R2_ACCESS_KEY_ID);
    });

    it("la API se queda sin el token de respaldos: ni en su configuración ni en su entorno", () => {
      const processEnv: Record<string, string | undefined> = {
        ...production,
        PATH: "/usr/bin",
      };
      const env = withoutBackupCredentials(loadEnv(processEnv), processEnv);

      expect(env.BACKUP_R2_ACCESS_KEY_ID).toBeUndefined();
      expect(env.BACKUP_R2_SECRET_ACCESS_KEY).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain("fake-backup");
      expect(backupStorageOf(env)).toBeNull();
      expect(env.BACKUP_TARGET).toBe("r2");
      expect(Object.isFrozen(env)).toBe(true);
      expect(processEnv).not.toHaveProperty("BACKUP_R2_ACCESS_KEY_ID");
      expect(processEnv).not.toHaveProperty("BACKUP_R2_SECRET_ACCESS_KEY");
      expect(processEnv.PATH).toBe("/usr/bin");
      expect(processEnv.R2_SECRET_ACCESS_KEY).toBe(validSource.R2_SECRET_ACCESS_KEY);
    });

    it("ignora la vuelta de Instagram del ejemplo de antes (sin /api) y usa la nueva", () => {
      const env = loadEnv({
        ...validSource,
        INSTAGRAM_REDIRECT_URI: "http://localhost:8787/oauth/instagram/callback",
      });
      expect(env.INSTAGRAM_REDIRECT_URI).toBe("http://localhost:8787/api/oauth/instagram/callback");
    });

    it("panelUrlOf: PUBLIC_URL en el servidor y el panel de Vite en el Mac", () => {
      expect(panelUrlOf(loadEnv(validSource))).toBe("http://localhost:5173");
      expect(panelUrlOf(loadEnv(production))).toBe("https://agentsales.agentpey.com");
    });

    it("el mensaje de error habla del archivo de entorno (también con ENV_FILE)", () => {
      expect(envErrorOf({ ...validSource, API_PORT: "x" }).message).toMatch(
        /^Configuración inválida en el archivo de entorno/,
      );
    });

    it("rechaza un API_HOST o un CLIENT_IP_HEADER con caracteres raros", () => {
      expect(
        envErrorOf({
          ...validSource,
          API_HOST: "0.0.0.0; rm",
          CLIENT_IP_HEADER: "Fly Client",
        }).issues.map((issue) => issue.variable),
      ).toEqual(["API_HOST", "CLIENT_IP_HEADER"]);
    });
  });
});
