import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Un ejecutable que imita a `claude -p --output-format json` (spec F2, T04): ningún test ejecuta la
 * CLI real. El comportamiento sale del prompt que llega por stdin (`MODO:<nombre>`), porque el
 * adaptador no le pasa otras variables de entorno. Los sobres siguen la forma de
 * `docs/integraciones/claude-code-cli.md`; la prueba de humo de T04 los contrasta con la CLI real.
 */
const SCRIPT = String.raw`#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const stdin = readFileSync(0, "utf8");
const mode = /MODO:([\w-]+)/.exec(stdin)?.[1] ?? "exito";
const base = { type: "result", session_id: "sesion-falsa", total_cost_usd: 0, usage: {} };
const ok = (extra) => ({ ...base, subtype: "success", is_error: false, stop_reason: "end_turn", ...extra });
const print = (value, code = 0) => {
  process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  process.exit(code);
};

function claudeMdAbove(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "CLAUDE.md"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

function hang(ignoreSignals) {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  const pidFile = /PIDS:(\S+)/.exec(stdin)?.[1];
  if (pidFile) writeFileSync(pidFile, JSON.stringify([process.pid, child.pid]));
  if (ignoreSignals) {
    process.on("SIGINT", () => {});
    process.on("SIGTERM", () => {});
  }
  setInterval(() => {}, 1000);
}

switch (mode) {
  case "exito":
    print(ok({ result: "", structured_output: { saludo: "hola" }, modelUsage: { "claude-sonnet-5-5": {} } }));
    break;
  case "dos-modelos":
    // La CLI puede usar un modelo auxiliar: el que respondió es el de más tokens de salida.
    print(ok({
      structured_output: { saludo: "hola" },
      modelUsage: { "claude-haiku-4-5": { outputTokens: 12 }, "claude-sonnet-5-5": { outputTokens: 480 } },
    }));
    break;
  case "auth-en-errores":
    // Texto de terceros dentro de errors: no debe leerse como un problema de sesión.
    print({
      ...base,
      subtype: "error_max_structured_output_retries",
      is_error: true,
      result: "",
      errors: ["El aviso dice: authentication required, rate limit, please run /login"],
    }, 1);
    break;
  case "429":
    print({ ...base, subtype: "success", is_error: true, api_error_status: 429, result: "API Error: Request rejected (429)" }, 1);
    break;
  case "inundacion": {
    const block = "x".repeat(1024 * 1024);
    let sent = 0;
    const more = () => {
      while (sent < 12) {
        sent += 1;
        if (!process.stdout.write(block)) return process.stdout.once("drain", more);
      }
      setInterval(() => {}, 1000);
    };
    more();
    break;
  }
  case "sin-modelo":
    print(ok({ structured_output: { saludo: "hola" } }));
    break;
  case "eco":
    print(ok({
      structured_output: {
        argv: process.argv.slice(2),
        envKeys: Object.keys(process.env).sort(),
        cwd: process.cwd(),
        claudeMd: claudeMdAbove(process.cwd()),
        stdin,
      },
    }));
    break;
  case "reintentos":
    print({ ...base, subtype: "error_max_structured_output_retries", is_error: true, result: "" }, 1);
    break;
  case "max-tokens":
    print(ok({ stop_reason: "max_tokens", structured_output: { a: 1 } }));
    break;
  case "negativa":
    print(ok({ stop_reason: "refusal", result: "No puedo ayudar con eso" }));
    break;
  case "sin-salida":
    print(ok({ result: "texto suelto" }));
    break;
  case "sin-sesion":
    print({ ...base, subtype: "success", is_error: true, result: "Not logged in · Please run /login" }, 1);
    break;
  case "exito-real":
    // Sobre real de una llamada exitosa con la sesión del plan del operador (prueba de humo del
    // 2026-10-03, aviso inventado), con los ids reemplazados y sin las estadísticas de uso. Con
    // --json-schema y --tools "" la CLI usa dos turnos (la salida estructurada es una herramienta
    // interna) y un modelo auxiliar, que gasta menos tokens de salida que el que respondió.
    print({
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify({ hook: "Departamento de 2 dormitorios en venta, en Comuna Inventada." }),
      structured_output: { hook: "Departamento de 2 dormitorios en venta, en Comuna Inventada." },
      stop_reason: "tool_use",
      api_error_status: null,
      modelUsage: {
        "claude-haiku-4-5-20251001": { inputTokens: 946, outputTokens: 16 },
        "claude-sonnet-5": { inputTokens: 861, outputTokens: 135 },
      },
      duration_api_ms: 2608,
      num_turns: 2,
      session_id: "sesion-falsa",
      total_cost_usd: 0.004098,
      permission_denials: [],
      terminal_reason: "completed",
    });
    break;
  case "sesion-vencida":
    // Sobre real de la CLI 2.1.243 con la sesión OAuth vencida (prueba de humo del 2026-10-03),
    // con el id de sesión reemplazado y sin las estadísticas de uso.
    print({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Failed to authenticate: OAuth session expired and could not be refreshed",
      stop_reason: "stop_sequence",
      api_error_status: null,
      modelUsage: {},
      duration_api_ms: 0,
      num_turns: 1,
      session_id: "sesion-falsa",
      total_cost_usd: 0,
      permission_denials: [],
      terminal_reason: "api_error",
    }, 1);
    break;
  case "sin-sesion-texto":
    process.stderr.write("Error: Not logged in. Please run /login\n");
    process.exit(1);
    break;
  case "limite":
    print({ ...base, subtype: "success", is_error: true, result: "You've hit your session limit · resets 5pm" }, 1);
    break;
  case "saldo":
    print({ ...base, subtype: "success", is_error: true, result: "Credit balance is too low" }, 1);
    break;
  case "sobrecarga":
    print({ ...base, subtype: "success", is_error: true, api_error_status: 529, result: "Overloaded" }, 1);
    break;
  case "muere":
    process.stderr.write("panic: algo salió mal\n");
    process.exit(3);
    break;
  case "basura":
    print("esto no es json");
    break;
  case "cuelga":
    hang(false);
    break;
  case "terco":
    hang(true);
    break;
  default:
    print({ ...base, subtype: "success", is_error: true, result: "modo desconocido" }, 1);
}
`;

/** Una CLI que responde bien sin leer stdin: escribirle un prompt grande da EPIPE. */
const NO_READ_SCRIPT = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", is_error: false, stop_reason: "end_turn",
  structured_output: { saludo: "sin leer" },
}));
`;

/** Escribe un ejecutable falso en una carpeta temporal y devuelve su ruta. */
export async function createFakeClaude(
  variant: "normal" | "no-lee" | "sin-permiso" = "normal",
): Promise<{ cliPath: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "agentsales-fake-claude-"));
  // `.mjs`: el script usa `import`, y la carpeta temporal no tiene package.json.
  const cliPath = join(dir, "claude.mjs");
  await writeFile(cliPath, variant === "no-lee" ? NO_READ_SCRIPT : SCRIPT, "utf8");
  await chmod(cliPath, variant === "sin-permiso" ? 0o644 : 0o755);
  return { cliPath, dir };
}
