import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, type LLMProvider, type LLMRequest, type LLMResponse } from "@agentsales/core";
import { z } from "zod";

export type ClaudeCliOptions = {
  /** Ejecutable de la CLI (`CLAUDE_CLI_PATH`). */
  cliPath: string;
  /** Modelo o alias (`LLM_MODEL`: `sonnet`, `opus`…). */
  model: string;
  /** Tope de cada llamada (`LLM_TIMEOUT_SECONDS`): la CLI no tiene uno propio. */
  timeoutMs: number;
  /**
   * Entorno del que se copian las variables permitidas (`CLAUDE_CLI_ENV_ALLOWLIST`). Lo pasa el
   * punto de entrada (`process.env`): los paquetes no leen el entorno por su cuenta.
   */
  baseEnv: Readonly<Record<string, string | undefined>>;
  /** Carpeta donde se crea el directorio de trabajo vacío. Por defecto, el temporal del sistema. */
  tmpDir?: string;
  /** Espera entre SIGINT, SIGTERM y SIGKILL al cortar el proceso. */
  killGraceMs?: number;
};

/**
 * Las únicas variables que recibe la CLI (spec F2 §4.5). Nunca las del `.env` (base de datos, R2,
 * cifrado) ni `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` o `CLAUDE_CODE_USE_*`: con una clave en
 * el entorno, la CLI cobra por API en vez de usar el plan del operador.
 */
export const CLAUDE_CLI_ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LANG", "TMPDIR"] as const;

/** Tope de lo que se lee de la CLI: el sobre trae solo el JSON pedido. */
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/**
 * Sobre de `claude -p --output-format json` (`docs/integraciones/claude-code-cli.md`). Solo se
 * validan los campos que se usan; el resto pasa sin revisar.
 */
const envelopeSchema = z.looseObject({
  type: z.string().optional(),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  stop_reason: z.string().nullable().optional(),
  api_error_status: z.number().nullable().optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
  errors: z.array(z.unknown()).optional(),
});
type Envelope = z.infer<typeof envelopeSchema>;

// Los textos de error de la CLI no son un contrato documentado: los fija la prueba de humo
// (F2-T04) y la nota de integración. Si cambian, el error cae en `LLM_UNAVAILABLE`. Con la sesión
// vencida, la 2.1.243 responde "Failed to authenticate: OAuth session expired and could not be
// refreshed" (visto en la prueba de humo del 2026-10-03).
// Los patrones se buscan solo en `result` (el mensaje de la CLI), nunca en `errors`, que puede
// traer texto del modelo o del aviso: un aviso que diga "authentication" no es un error de sesión.
// Un 429 transitorio de la API (`api_error_status`) es `LLM_UNAVAILABLE`, reintentable; el límite
// del plan y el saldo se reconocen por su texto.
const AUTH_PATTERN =
  /not logged in|please run \/login|invalid api key|failed to authenticate|oauth session expired/i;
const LIMIT_PATTERN = /hit your .*limit|usage limit|credit balance is too low/i;
const OUTPUT_SUBTYPES = new Set(["error_max_structured_output_retries", "error_max_turns"]);
const OUTPUT_STOP_REASONS = new Set(["max_tokens", "refusal"]);

const MESSAGES = {
  auth: "La CLI de Claude no tiene sesión: ábrela con `claude` y usa /login",
  limit: "Se alcanzó el límite de uso del plan de Claude: intenta más tarde",
  output: "La IA no entregó la salida estructurada pedida",
  unavailable: "La CLI de Claude no respondió bien",
  timeout: "La CLI de Claude no respondió a tiempo",
  aborted: "Se cortó la llamada a la CLI de Claude",
  notInstalled: "No se encontró la CLI de Claude (revisa CLAUDE_CLI_PATH)",
} as const;

const llmError = (code: string, message: string, retriable: boolean, details = {}) =>
  new AppError(code, message, { retriable, details });

/** Clasifica un texto de error de la CLI (sin guardarlo: puede traer cualquier cosa). */
function classifyText(text: string): AppError | null {
  if (AUTH_PATTERN.test(text)) return llmError("LLM_AUTH_REQUIRED", MESSAGES.auth, false);
  if (LIMIT_PATTERN.test(text)) return llmError("LLM_RATE_LIMITED", MESSAGES.limit, false);
  return null;
}

/** Tokens de salida de una entrada de `modelUsage` (la forma no es un contrato: 0 si no está). */
function outputTokens(usage: unknown): number {
  if (typeof usage !== "object" || usage === null || !("outputTokens" in usage)) return 0;
  return typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
}

/**
 * El modelo que respondió: el de `modelUsage` con más tokens de salida (la CLI puede usar un
 * modelo auxiliar para tareas internas), o el configurado si no hay datos.
 */
function respondingModel(modelUsage: Envelope["modelUsage"], fallbackModel: string): string {
  const entries = Object.entries(modelUsage ?? {});
  const best = entries.reduce<[string, unknown] | undefined>(
    (top, entry) =>
      top === undefined || outputTokens(entry[1]) > outputTokens(top[1]) ? entry : top,
    undefined,
  );
  return best?.[0] ?? fallbackModel;
}

/** Del sobre a la respuesta o al error tipado (spec F2 §4.5). */
export function interpretEnvelope(envelope: Envelope, fallbackModel: string): LLMResponse {
  const details = {
    subtype: envelope.subtype,
    stopReason: envelope.stop_reason,
    apiErrorStatus: envelope.api_error_status,
  };
  // Primero lo que dice el sobre de forma estructurada; el texto, al final y solo de `result`.
  if (
    OUTPUT_SUBTYPES.has(envelope.subtype ?? "") ||
    OUTPUT_STOP_REASONS.has(envelope.stop_reason ?? "")
  ) {
    throw llmError("LLM_OUTPUT_INVALID", MESSAGES.output, false, details);
  }
  if (envelope.is_error === true || envelope.subtype !== "success") {
    if (envelope.api_error_status === 401) {
      throw llmError("LLM_AUTH_REQUIRED", MESSAGES.auth, false, details);
    }
    throw (
      classifyText(envelope.result ?? "") ??
      llmError("LLM_UNAVAILABLE", MESSAGES.unavailable, true, details)
    );
  }
  if (envelope.structured_output === undefined) {
    throw llmError("LLM_OUTPUT_INVALID", MESSAGES.output, false, details);
  }
  return {
    data: envelope.structured_output,
    model: respondingModel(envelope.modelUsage, fallbackModel),
  };
}

/** El entorno de la CLI: solo las variables permitidas. */
export function claudeCliEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CLAUDE_CLI_ENV_ALLOWLIST) {
    const value = baseEnv[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Los argumentos de la CLI (spec F2 §4.5). El prompt del usuario va por stdin, nunca aquí. */
export function claudeCliArgs(request: LLMRequest, model: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(request.jsonSchema),
    "--model",
    model,
    "--system-prompt",
    request.system,
    // Sin herramientas, sin CLAUDE.md, skills, plugins, hooks ni MCP; la sesión del plan sigue.
    "--tools",
    "",
    "--safe-mode",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
  ];
}

type RunResult = { stdout: string; stderr: string; exitCode: number | null };

/**
 * Ejecuta la CLI en su propio grupo de procesos, para poder cortarla completa (la CLI lanza
 * subprocesos). Al vencer el tope o al dispararse `signal`: SIGINT, después SIGTERM y al final
 * SIGKILL, con `killGraceMs` entre cada uno.
 */
function runCli(options: ClaudeCliOptions, request: LLMRequest, cwd: string): Promise<RunResult> {
  const grace = options.killGraceMs ?? 2000;
  return new Promise((resolve, reject) => {
    const child = spawn(options.cliPath, claudeCliArgs(request, options.model), {
      cwd,
      env: claudeCliEnv(options.baseEnv),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stopReason: "timeout" | "aborted" | "overflow" | null = null;
    const timers: NodeJS.Timeout[] = [];
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // El grupo ya terminó.
      }
    };
    const stop = (reason: "timeout" | "aborted" | "overflow") => {
      if (stopReason !== null) return;
      stopReason = reason;
      killGroup("SIGINT");
      timers.push(setTimeout(() => killGroup("SIGTERM"), grace));
      timers.push(setTimeout(() => killGroup("SIGKILL"), grace * 2));
    };
    timers.push(setTimeout(() => stop("timeout"), options.timeoutMs));
    const onAbort = () => stop("aborted");
    if (request.signal?.aborted) onAbort();
    request.signal?.addEventListener("abort", onAbort, { once: true });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= MAX_STDOUT_BYTES) stdout.push(chunk);
      else stop("overflow");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_STDERR_BYTES) stderr.push(chunk);
    });
    // Si la CLI termina sin leer stdin, escribirle da EPIPE: no es un error de la llamada.
    child.stdin.on("error", () => {});
    child.stdin.end(request.prompt);

    const cleanup = () => {
      for (const timer of timers) clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(
        error.code === "ENOENT" || error.code === "EACCES"
          ? llmError("LLM_NOT_CONFIGURED", MESSAGES.notInstalled, false, { code: error.code })
          : llmError("LLM_UNAVAILABLE", MESSAGES.unavailable, true, { code: error.code }),
      );
    });
    child.on("close", (exitCode) => {
      cleanup();
      // Si se cortó, un último SIGKILL al grupo: algún hijo de la CLI pudo sobrevivir al padre.
      if (stopReason !== null) killGroup("SIGKILL");
      if (stopReason === "timeout") {
        reject(llmError("LLM_TIMEOUT", MESSAGES.timeout, true, { timeoutMs: options.timeoutMs }));
        return;
      }
      if (stopReason === "aborted") {
        reject(llmError("LLM_ABORTED", MESSAGES.aborted, true));
        return;
      }
      if (stopReason === "overflow") {
        reject(llmError("LLM_OUTPUT_INVALID", MESSAGES.output, false, { stdoutBytes }));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
      });
    });
  });
}

/** Lee el sobre de la salida; `null` si no es el JSON esperado. */
export function parseEnvelope(stdout: string): Envelope | null {
  try {
    const parsed = envelopeSchema.safeParse(JSON.parse(stdout.trim()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Proveedor `claude-cli` (ADR-0003): `claude -p` como subproceso, con el plan del operador.
 * **Solo uso propio.** Corre en un directorio vacío del temporal del sistema (fuera del repo: la
 * CLI lee el `CLAUDE.md` de los directorios padre) y con un entorno mínimo. No loguea nada: el
 * prompt y la respuesta traen datos de clientes.
 */
export function createClaudeCliProvider(options: ClaudeCliOptions): LLMProvider {
  return {
    name: "claude-cli",
    async generateStructured(request) {
      // Ya cortado: no se crea el directorio ni se lanza la CLI.
      if (request.signal?.aborted) throw llmError("LLM_ABORTED", MESSAGES.aborted, true);
      let cwd: string;
      try {
        cwd = await mkdtemp(join(options.tmpDir ?? tmpdir(), "agentsales-claude-"));
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error ? error.code : null;
        throw llmError("LLM_UNAVAILABLE", MESSAGES.unavailable, true, { code });
      }
      try {
        const { stdout, stderr, exitCode } = await runCli(options, request, cwd);
        const envelope = parseEnvelope(stdout);
        if (envelope === null) {
          throw (
            classifyText(`${stdout}\n${stderr}`) ??
            llmError("LLM_UNAVAILABLE", MESSAGES.unavailable, true, { exitCode })
          );
        }
        return interpretEnvelope(envelope, options.model);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}
