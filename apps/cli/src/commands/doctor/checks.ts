import { IMAGE_AI_DEFAULTS } from "@agentsales/config";
import {
  brokersLiveNow,
  type HealthReport,
  hasLlmPrice,
  nextWorkerCheckText,
  type PublishMode,
  splitAutoPublish,
  workerScheduleText,
  workerStatusText,
} from "@agentsales/core";
import { canDumpServer, parsePgToolVersion, parseServerVersion } from "@agentsales/db/backup";
import {
  CHROMIUM_INSTALL_COMMAND,
  FFMPEG_MIN_VERSION,
  isSupportedFfmpeg,
  parseFfmpegVersion,
} from "@agentsales/media/tools";
import { apiHint, type HealthFetcher } from "../../api-client.js";
import type { EnvResult } from "../../env.js";
import { describeServer, type ServerResolution } from "../../server.js";

export type Level = "ok" | "warn" | "error";

export type CheckItem = {
  name: string;
  level: Level;
  detail: string;
  hint?: string;
  /** `danger`: se destaca en rojo aunque sea una advertencia (`PUBLISH_MODE=live`). */
  emphasis?: "danger";
};

/** Ejecuta un comando y devuelve su salida; lanza si no existe, falla o tarda demasiado. */
/** Ejecuta un comando; con `env`, el proceso recibe solo ese entorno (no el de la CLI). */
export type RunCommand = (
  command: string,
  args: readonly string[],
  options?: { env?: Record<string, string> },
) => Promise<string>;

const REQUIRED_NODE_MAJOR = 26;

export function checkNode(version: string): CheckItem {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  return major === REQUIRED_NODE_MAJOR
    ? { name: "Node", level: "ok", detail: version }
    : {
        name: "Node",
        level: "error",
        detail: `${version}; el proyecto usa Node ${REQUIRED_NODE_MAJOR}`,
        hint: `Instala Node ${REQUIRED_NODE_MAJOR} (ADR-0008)`,
      };
}

/** Nunca muestra valores: solo nombres de variables y el motivo. */
export function checkEnv(result: EnvResult): CheckItem {
  if (result.ok) {
    return { name: ".env", level: "ok", detail: "válido" };
  }
  if (!result.fileFound) {
    return {
      name: ".env",
      level: "error",
      detail: "no se encontró el archivo .env en la raíz",
      hint: "cp .env.example .env y completa las variables (docs/09-alta-neon-r2.md)",
    };
  }
  return {
    name: ".env",
    level: "error",
    detail: result.issues.map((issue) => `${issue.variable} (${issue.message})`).join("; "),
    hint: "Corrige esas variables en .env (ver .env.example)",
  };
}

/**
 * El par de la app de Instagram (spec F3 §4.6): lo necesita la conexión con el botón (OAuth, F7).
 * Conectar con el token del panel y refrescarlo no lo usan (D4), así que es una advertencia. Nunca muestra los valores. `null` si el `.env`
 * no es válido (ya lo informa `checkEnv`).
 */
export function checkInstagram(result: EnvResult): CheckItem | null {
  if (!result.ok) return null;
  const missing = (["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"] as const).filter(
    (name) => result.env[name] === undefined,
  );
  if (missing.length === 0) {
    return {
      name: "Instagram",
      level: "ok",
      detail: "INSTAGRAM_APP_ID e INSTAGRAM_APP_SECRET definidas",
    };
  }
  return {
    name: "Instagram",
    level: "warn",
    detail: `falta ${missing.join(" y ")}: la conexión con el botón (OAuth) no funcionará; con el token del panel no hace falta`,
    hint: "Copia el identificador y la clave de la app de Instagram (docs/integraciones/instagram.md §2.1)",
  };
}

/**
 * El par de la app de Mercado Libre (spec F4 §4.2): sin él no se conecta la cuenta ni se refresca su
 * token (a diferencia de Instagram, el refresco lo exige). Es una advertencia, como Instagram: el
 * resto del sistema funciona sin Portal. La dirección de
 * retorno siempre tiene valor (por defecto `https://agentsales.test/…`) y se muestra, porque debe ser la
 * misma registrada en la app; no es secreta. Nunca muestra el par. `null` si el `.env` no es válido.
 */
export function checkMercadoLibre(result: EnvResult): CheckItem | null {
  if (!result.ok) return null;
  const missing = (["ML_APP_ID", "ML_CLIENT_SECRET"] as const).filter(
    (name) => result.env[name] === undefined,
  );
  const redirect = `dirección de retorno ${result.env.ML_REDIRECT_URI}`;
  if (missing.length === 0) {
    return {
      name: "Mercado Libre",
      level: "ok",
      detail: `ML_APP_ID y ML_CLIENT_SECRET definidas; ${redirect}`,
    };
  }
  return {
    name: "Mercado Libre",
    level: "warn",
    detail: `falta ${missing.join(" y ")}: no se podrá conectar la cuenta ni refrescar el token de una ya conectada (deja de funcionar en horas); ${redirect}`,
    hint: "Crea la app en developers.mercadolibre.cl con esa misma dirección de retorno y anota el par en .env (docs/07-checklist-cuentas.md)",
  };
}

/**
 * El token del Banco Central para el valor de la UF (spec F5 §4.6): sin él, un aviso en UF no se
 * puede publicar en Marketplace (su precio se convierte a pesos). Advertencia: lo demás funciona.
 * Nunca muestra el token. `null` si el `.env` no es válido.
 */
export function checkUfSource(result: EnvResult): CheckItem | null {
  if (!result.ok) return null;
  if (result.env.BCCH_API_TOKEN !== undefined) {
    return { name: "Valor de la UF", level: "ok", detail: "BCCH_API_TOKEN definida (dura 1 año)" };
  }
  return {
    name: "Valor de la UF",
    level: "warn",
    detail: "falta BCCH_API_TOKEN: los avisos en UF no se podrán publicar en Marketplace",
    hint: "Pide el token gratis en la API BDE del Banco Central (docs/07-checklist-cuentas.md, Antes de F5)",
  };
}

/**
 * El modelo de la API (F7-T12): con la clave puesta, uno que no está en la tabla de precios se
 * estima con el más caro (el tope sigue frenando, pero el gasto sale alto). `null` si está o si no
 * hay clave.
 */
export function checkAnthropicModel(result: EnvResult): CheckItem | null {
  if (!result.ok || (result.env.ANTHROPIC_API_KEY ?? "") === "") return null;
  if (hasLlmPrice(result.env.ANTHROPIC_MODEL)) return null;
  return {
    name: "anthropic_model",
    level: "warn",
    detail: `ANTHROPIC_MODEL=${result.env.ANTHROPIC_MODEL} no está en la tabla de precios: el gasto se estima con el modelo más caro`,
    hint: "revisa el nombre del modelo, o agrega su precio en packages/core/src/llm-usage.ts",
  };
}

/**
 * La IA de imágenes (F9.5-T25): con la clave puesta, un modelo distinto del de por defecto con el
 * precio de por defecto anota un gasto que probablemente no es el real (y el tope frena a
 * destiempo). `null` sin clave o si el precio también se cambió.
 */
export function checkImageAiPrice(result: EnvResult): CheckItem | null {
  if (!result.ok || (result.env.GEMINI_API_KEY ?? "") === "") return null;
  const { IMAGE_AI_MODEL: model, IMAGE_AI_PRICE_USD: price } = result.env;
  if (model === IMAGE_AI_DEFAULTS.model || price !== IMAGE_AI_DEFAULTS.priceUsd) return null;
  return {
    name: "image_ai_price",
    level: "warn",
    detail: `IMAGE_AI_MODEL=${model} con el precio por defecto (${IMAGE_AI_DEFAULTS.priceUsd}): el gasto de las imágenes con IA puede no ser el real`,
    hint: "pon en IMAGE_AI_PRICE_USD el precio por imagen de ese modelo (ai.google.dev/gemini-api/docs/pricing)",
  };
}

/**
 * El modo que manda es el de la API en ejecución (`/health`); si no responde, el del `.env`.
 * Si no coinciden, es un error: la API se levantó con otra configuración.
 */
export function checkPublishMode(
  apiMode: PublishMode | undefined,
  envMode: PublishMode | undefined,
  remote = false,
): CheckItem | null {
  const mode = apiMode ?? envMode;
  if (!mode) {
    return null;
  }
  if (apiMode && envMode && apiMode !== envMode) {
    return {
      name: "PUBLISH_MODE",
      level: "error",
      detail: `la API corre en ${apiMode} pero .env dice ${envMode}`,
      hint: "Reinicia pnpm dev para que la API tome el .env actual",
      ...(apiMode === "live" ? { emphasis: "danger" as const } : {}),
    };
  }
  const source = apiMode
    ? remote
      ? "según el servidor"
      : "según la API"
    : "según .env; la API no responde";
  return mode === "live"
    ? {
        name: "PUBLISH_MODE",
        level: "warn",
        detail: `LIVE: el servidor permite publicar de verdad; salen de verdad solo las marcas en vivo (${source})`,
        hint: remote
          ? "Es una variable del servidor (PUBLISH_MODE): vuelve a dry-run allí si no estás publicando de verdad"
          : "Vuelve a dry-run en .env si no estás publicando de verdad",
        emphasis: "danger",
      }
    : { name: "PUBLISH_MODE", level: "ok", detail: `dry-run: no se publica nada (${source})` };
}

const SERVICES = {
  db: {
    name: "Base de datos",
    hint: "Neon puede estar despertando: reintenta; si sigue, revisa DATABASE_URL (conexión directa, sin -pooler)",
  },
  storage: {
    name: "Almacenamiento",
    hint: "Revisa las variables R2_* en .env y corre pnpm storage:check",
  },
  queue: { name: "Cola", hint: "Arranca el worker una vez (pnpm dev)" },
} as const;

type ServiceKey = keyof typeof SERVICES;

/** Con un servidor remoto, lo que se arregla está en el servidor, no en el `.env` del Mac. */
const REMOTE_SERVICE_HINTS: Record<ServiceKey, string> = {
  db: "Neon puede estar despertando: reintenta; si sigue, revisa DATABASE_URL en los secretos del servidor",
  storage: "Revisa las variables R2_* en los secretos del servidor",
  queue: "La cola no respondió en el servidor: revisa que el worker esté encendido",
};

/** API más db, storage y cola, todo desde `/health` (la CLI no duplica los checks). */
export async function checkServices(
  fetchHealth: HealthFetcher,
  remote = false,
): Promise<{ items: CheckItem[]; report: HealthReport | null }> {
  let report: HealthReport;
  try {
    report = await fetchHealth();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      report: null,
      items: [
        { name: "API", level: "error", detail: `no responde: ${reason}`, hint: apiHint(error) },
        ...Object.values(SERVICES).map(
          ({ name }): CheckItem => ({
            name,
            level: "error",
            detail: "sin datos: la API no responde",
          }),
        ),
      ],
    };
  }
  const api: CheckItem = {
    name: "API",
    level: "ok",
    detail: `responde (versión ${report.version ?? "?"}, ${report.status})`,
  };
  const reportChecks = report.checks;
  // Sin el detalle (sin sesión de administrador, spec F7 §4.3), los servicios no se pueden revisar.
  if (reportChecks === undefined) {
    return {
      report,
      items: [
        api,
        ...Object.values(SERVICES).map(
          ({ name }): CheckItem => ({
            name,
            level: "warn",
            detail: "sin datos: el detalle lo ve el administrador",
            hint: remote
              ? "Inicia sesión en el servidor: agentsales login --email <correo> --api <dirección>"
              : "Inicia sesión con agentsales login",
          }),
        ),
      ],
    };
  }
  const services = (Object.keys(SERVICES) as ServiceKey[]).map((key): CheckItem => {
    const result = reportChecks[key];
    const { name } = SERVICES[key];
    const hint = remote ? REMOTE_SERVICE_HINTS[key] : SERVICES[key].hint;
    if (!result.ok) {
      return { name, level: "error", detail: result.error ?? "falló", hint };
    }
    const detail =
      key === "queue" ? `inicializada, ${result.latencyMs} ms` : `${result.latencyMs} ms`;
    return { name, level: "ok", detail };
  });
  return { report, items: [api, ...services] };
}

/** Motivo legible de un comando que falló (sin exponer la salida completa). */
export function describeCommandError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    if ("code" in error && error.code === "ENOENT") return "no encontrado";
    if ("killed" in error && error.killed === true) return "no respondió a tiempo";
    if ("code" in error && typeof error.code === "number") return `salió con código ${error.code}`;
  }
  return error instanceof Error ? error.message : String(error);
}

const firstLine = (output: string) => output.split("\n")[0]?.trim() || "(sin versión)";

/**
 * ffmpeg o ffprobe (spec F2 §4.8): que exista y sea 8.1 o más nuevo (las fotos HEIC del iPhone,
 * hechas de mosaicos, necesitan 8.1). Una versión que no se reconoce (un build de desarrollo) pasa.
 */
export async function checkFfmpegTool(
  run: RunCommand,
  name: "ffmpeg" | "ffprobe",
  path: string,
): Promise<CheckItem> {
  const variable = name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
  let output: string;
  try {
    output = await run(path, ["-version"]);
  } catch (error) {
    return {
      name,
      level: "error",
      detail: `${path}: ${describeCommandError(error)}`,
      hint: `brew install ffmpeg (trae ffprobe), o ajusta ${variable} en .env`,
    };
  }
  const version = parseFfmpegVersion(output);
  if (!isSupportedFfmpeg(version)) {
    return {
      name,
      level: "error",
      detail: `${firstLine(output)} (se necesita ${FFMPEG_MIN_VERSION.major}.${FFMPEG_MIN_VERSION.minor} o más nueva)`,
      hint: "brew upgrade ffmpeg",
    };
  }
  return { name, level: "ok", detail: firstLine(output) };
}

/**
 * El Chromium que pide la versión de Playwright del proyecto (spec F2 §4.8): desde F2 dibuja la
 * portada, la ficha y el texto del reel, así que falta es un error. `null` si Playwright no cargó.
 */
export function checkChromium(status: { path: string; installed: boolean } | null): CheckItem {
  const name = "Chromium (Playwright)";
  if (status?.installed) return { name, level: "ok", detail: status.path };
  return {
    name,
    level: "error",
    detail: status === null ? "no se pudo revisar (Playwright no cargó)" : "no instalado",
    hint: CHROMIUM_INSTALL_COMMAND,
  };
}

/** Sesión de la CLI según `claude auth status --json`. */
type ClaudeSession = "plan" | "api-key" | "none" | "unknown";

/**
 * `plan` solo con la sesión de claude.ai (la que usa el adaptador `claude-cli`). Una API key
 * también da `loggedIn: true`, pero el adaptador no se la pasa a la CLI: no cuenta como sesión.
 */
function parseSession(output: string): ClaudeSession {
  try {
    const status: unknown = JSON.parse(output);
    if (typeof status !== "object" || status === null || !("loggedIn" in status)) return "unknown";
    if (status.loggedIn !== true) return "none";
    const method = "authMethod" in status ? status.authMethod : undefined;
    return method === "claude.ai" || method === "oauth_token" ? "plan" : "api-key";
  } catch {
    return "unknown";
  }
}

/**
 * La sesión de la CLI, sin gastar cuota, con el mismo entorno mínimo que usa el adaptador (sin
 * `ANTHROPIC_API_KEY` ni nada del `.env`). Sin sesión, `claude auth status` sale con código 1 y el
 * JSON igual va en stdout, que trae el error de `execFile`.
 */
async function claudeSession(
  run: RunCommand,
  cliPath: string,
  env: Record<string, string>,
): Promise<ClaudeSession> {
  try {
    return parseSession(await run(cliPath, ["auth", "status", "--json"], { env }));
  } catch (error) {
    const stdout =
      typeof error === "object" && error !== null && "stdout" in error ? error.stdout : undefined;
    return typeof stdout === "string" ? parseSession(stdout) : "unknown";
  }
}

const CLAUDE_LOGIN_HINT =
  "Abre `claude` en una terminal e inicia sesión con /login (docs/07-checklist-cuentas.md)";

/** La CLI de Claude (proveedor `claude-cli`, spec F2 §4.8): que exista y que tenga sesión. */
export async function checkClaude(
  run: RunCommand,
  cliPath: string,
  env: Record<string, string>,
): Promise<CheckItem> {
  let version: string;
  try {
    version = firstLine(await run(cliPath, ["--version"], { env }));
  } catch (error) {
    return {
      name: "Claude Code",
      level: "warn",
      detail: `${describeCommandError(error)}; se necesita para generar contenido (F2)`,
      hint: "Instala Claude Code e inicia sesión, o ajusta CLAUDE_CLI_PATH en .env",
    };
  }
  const session = await claudeSession(run, cliPath, env);
  if (session === "plan") {
    return { name: "Claude Code", level: "ok", detail: `${version} · sesión iniciada` };
  }
  const detail: Record<Exclude<ClaudeSession, "plan">, string> = {
    none: "sin sesión: no se puede generar contenido",
    "api-key": "solo con una API key, que el sistema no le pasa: inicia sesión con tu plan",
    unknown: "no se pudo revisar la sesión",
  };
  return {
    name: "Claude Code",
    level: "warn",
    detail: `${version} · ${detail[session]}`,
    hint: CLAUDE_LOGIN_HINT,
  };
}

/**
 * `pg_dump` del respaldo local (F6-T14, spec F6 §4.11): que esté y que su versión mayor alcance para
 * la del servidor que informa `/health` (`database.serverVersion`): `pg_dump` se niega a volcar un
 * servidor más nuevo. Sin la herramienta es una advertencia (la app funciona, pero no se respalda);
 * una versión que no alcanza es un error (el respaldo fallaría siempre).
 */
export async function checkPgDump(
  run: RunCommand,
  findTool: () => string,
  serverVersion: string | null | undefined,
): Promise<CheckItem> {
  const name = "pg_dump";
  let path: string;
  try {
    path = findTool();
  } catch {
    return {
      name,
      level: "warn",
      detail: "no está: el respaldo de la base no corre",
      hint: "brew install libpq (queda en /opt/homebrew/opt/libpq/bin; o fija PG_BIN_DIR en .env)",
    };
  }
  let output: string;
  try {
    output = await run(path, ["--version"]);
  } catch (error) {
    return { name, level: "warn", detail: `${path}: ${describeCommandError(error)}` };
  }
  const client = parsePgToolVersion(output);
  const server = serverVersion == null ? null : parseServerVersion(serverVersion);
  if (client === null) {
    return { name, level: "warn", detail: `no se pudo leer la versión: ${firstLine(output)}` };
  }
  const clientText = `${client.major}${client.minor === null ? "" : `.${client.minor}`}`;
  if (server === null) {
    return {
      name,
      level: "ok",
      detail: `${clientText} (sin la versión de la base: se compara con la API corriendo)`,
    };
  }
  if (!canDumpServer(client, server)) {
    return {
      name,
      level: "error",
      detail: `${clientText}, pero la base es ${serverVersion}: pg_dump no puede respaldar una base más nueva`,
      hint: "brew upgrade libpq (o instala el cliente de la misma versión de la base)",
    };
  }
  return { name, level: "ok", detail: `${clientText} (la base es ${serverVersion})` };
}

/** El último respaldo según `/health` (F6-T14): avisa si no hay, si falló o si tiene más de 48 h. */
export function checkBackup(report: HealthReport | null, now: Date = new Date()): CheckItem | null {
  if (report === null || report.backup === undefined) return null;
  const name = "Respaldo";
  const backup = report.backup;
  if (backup === null || backup.lastSuccessAt === null) {
    return {
      name,
      level: "warn",
      detail: "todavía no hay respaldos de la base",
      hint: "pnpm db:backup (no necesita pnpm dev); el worker respalda solo cada día a las 13:00",
    };
  }
  const elapsed = now.getTime() - Date.parse(backup.lastSuccessAt);
  const hours = Number.isNaN(elapsed) ? "?" : String(Math.floor(elapsed / 3_600_000));
  const failure =
    backup.lastFailureCode === null ? "" : `; el último intento falló (${backup.lastFailureCode})`;
  return backup.stale || failure !== ""
    ? {
        name,
        level: "warn",
        detail: `el último bueno es de hace ${hours} h${failure}`,
        hint: "pnpm db:backup para ver el error (necesita pg_dump: brew install libpq)",
      }
    : { name, level: "ok", detail: `el último es de hace ${hours} h (${backup.lastFile ?? "?"})` };
}

/**
 * La clave de la API de Anthropic (F7-T12, spec F7 §4.7): con corredores que la necesitan y sin
 * `ANTHROPIC_API_KEY`, una advertencia (sus textos fallarán). `null` si no falta o la API no responde.
 */
export function checkLlmKey(report: HealthReport | null): CheckItem | null {
  const brokers = report?.llmKeyMissingBrokers ?? [];
  if (brokers.length === 0) return null;
  return {
    name: "anthropic_api",
    level: "warn",
    detail: `falta ANTHROPIC_API_KEY: los textos de ${brokers.join(", ")} fallarán`,
    hint: "agrega ANTHROPIC_API_KEY al .env y reinicia pnpm dev",
  };
}

/**
 * El doble factor (F8-T15, spec F8 §4.8): recomendado para el administrador. Una advertencia por
 * los administradores activos que no lo tienen; `null` si todos lo tienen o la API no lo informa.
 */
export function checkAdminTotp(report: HealthReport | null): CheckItem | null {
  const admins = report?.adminsWithoutTotp ?? [];
  if (admins.length === 0) return null;
  return {
    name: "Doble factor",
    level: "warn",
    detail: `${admins.join(", ")} sin doble factor (recomendado para el administrador)`,
    hint: "actívalo en el panel: Mi cuenta → Activar el doble factor",
  };
}

/**
 * `auto_publish` (F6-T11, spec F6 §4.10): con la API en vivo y corredores que lo tienen, una
 * advertencia destacada en rojo (publica sin revisión); en simulación, solo informa. `null` si
 * ningún corredor lo tiene o la API no responde.
 */
export function checkAutoPublish(report: HealthReport | null): CheckItem | null {
  if (report?.autoPublishBrokers === null && report.publishMode === "live") {
    return {
      name: "auto_publish",
      level: "warn",
      detail: "no se pudo saber si algún corredor lo tiene (la base no respondió)",
    };
  }
  if (report === null) return null;
  // Solo cuenta como «en vivo» la marca encendida con el servidor en `live` (ADR-0036).
  const { live, simulated } = splitAutoPublish(report);
  if (live.length > 0) {
    return {
      name: "auto_publish",
      level: "warn",
      detail: `EN VIVO: publica sin tu revisión (${live.join(", ")})`,
      hint: "agentsales brokers auto-publish <slug> off, o agentsales brokers live <slug> off",
      emphasis: "danger",
    };
  }
  return simulated.length === 0
    ? null
    : {
        name: "auto_publish",
        level: "ok",
        detail: `activado en simulación (${simulated.join(", ")})`,
      };
}

/**
 * Las marcas con el modo en vivo encendido (F9.5-T22, ADR-0036): una advertencia en rojo si
 * publican de verdad (servidor en `live`); en simulación, solo informa. `null` si el reporte no
 * trae la lista (sin sesión de administrador o una API anterior) o no hay marcas encendidas con el
 * servidor en simulación.
 */
export function checkLiveBrokers(report: HealthReport | null): CheckItem | null {
  if (report === null || report.liveBrokers === undefined) return null;
  if (report.liveBrokers === null) {
    return {
      name: "Marcas en vivo",
      level: "warn",
      detail: "no se pudo saber cuáles están en vivo (la base no respondió)",
    };
  }
  const live = brokersLiveNow(report) ?? [];
  if (live.length > 0) {
    return {
      name: "Marcas en vivo",
      level: "warn",
      detail: `publican de verdad: ${live.join(", ")}`,
      hint: "agentsales brokers live <slug> off apaga una marca",
      emphasis: "danger",
    };
  }
  return report.liveBrokers.length === 0
    ? { name: "Marcas en vivo", level: "ok", detail: "ninguna: todo sale en simulación" }
    : {
        name: "Marcas en vivo",
        level: "ok",
        detail: `encendidas pero en simulación mientras el servidor esté en dry-run (${report.liveBrokers.join(", ")})`,
      };
}

/**
 * A qué servidor habla la CLI (spec F8 §4.5): `AGENTSALES_API_URL`, el guardado con la sesión o la
 * API local. Una dirección inválida es un error (la CLI no llama a ninguno).
 */
export function checkServer(resolution: ServerResolution): CheckItem {
  if (!resolution.ok) {
    return {
      name: "Servidor",
      level: "error",
      detail: resolution.error.message,
      hint: "Corrige AGENTSALES_API_URL, o entra de nuevo con agentsales login --api https://<dominio>",
    };
  }
  const { target } = resolution;
  if (target.sessionUrl !== null && target.sessionUrl !== target.url) {
    return {
      name: "Servidor",
      level: "warn",
      detail: `${describeServer(target)}; tu sesión es de ${target.sessionUrl}, así que aquí vas sin sesión`,
      hint: "Entra en ese servidor con agentsales login --api, o quita AGENTSALES_API_URL",
    };
  }
  return { name: "Servidor", level: "ok", detail: describeServer(target) };
}

/**
 * El ambiente que informa `/health` (spec F8 §4.2): la API del Mac debe ser de desarrollo (si no,
 * el `.env` apunta a producción), y un servidor remoto, de producción. `null` si la API no lo dice
 * (una anterior a F8) o si es el esperado en el Mac.
 */
export function checkEnvironment(report: HealthReport | null, remote: boolean): CheckItem | null {
  const environment = report?.environment;
  if (environment === undefined) return null;
  if (!remote) {
    return environment === "production"
      ? {
          name: "Ambiente",
          level: "error",
          detail: "la API de este Mac corre como producción",
          hint: "Quita NODE_ENV=production del .env: en el Mac se usa la rama dev de Neon y el bucket de desarrollo",
        }
      : null;
  }
  return environment === "production"
    ? { name: "Ambiente", level: "ok", detail: "producción" }
    : {
        name: "Ambiente",
        level: "warn",
        detail: "el servidor dice que es de desarrollo: ¿es el que esperabas?",
        hint: "Revisa la dirección con agentsales whoami",
      };
}

/**
 * El worker según su latido (F8-T12, spec F8 §4.10): encendido es ok; apagado, una advertencia
 * (sin él no se prepara, no se publica ni corre lo programado). `null` si la API no lo informa.
 */
export function checkWorker(report: HealthReport | null, remote: boolean): CheckItem | null {
  if (report === null || report.worker === undefined) return null;
  const detail = workerStatusText(report.worker);
  if (report.worker?.running === true) return { name: "Worker", level: "ok", detail };
  return {
    name: "Worker",
    level: "warn",
    detail,
    ...(report.worker === null
      ? {}
      : {
          hint: !remote
            ? "Arráncalo con pnpm dev si lo necesitas"
            : report.workerSchedule === true
              ? "Se enciende solo en la próxima revisión del horario; para encenderlo ya: GitHub → Actions → «Encender el worker» → Run workflow (docs/10-despliegue.md, paso 8)"
              : "Sin horario no se enciende solo: enciéndelo (GitHub → Actions → «Encender el worker», o docs/10-despliegue.md, paso 8) y apágalo al terminar",
        }),
  };
}

/**
 * El horario del worker en el servidor (F9.5-T24, ADR-0037): con el apagado solo activado
 * (`workerSchedule`), cada cuánto revisa el workflow y la próxima revisión, en hora de Chile; sin él,
 * que no hay horario y el worker debe estar encendido. `null` si el servidor no lo informa.
 */
export function checkWorkerSchedule(report: HealthReport | null, now: Date): CheckItem | null {
  if (report?.workerSchedule === undefined) return null;
  return report.workerSchedule
    ? {
        name: "Horario del worker",
        level: "ok",
        detail: `próxima revisión ${nextWorkerCheckText(now)} (${workerScheduleText()})`,
      }
    : {
        name: "Horario del worker",
        level: "ok",
        detail: "sin horario: el worker no se apaga solo y debe estar encendido",
      };
}
