import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { findWorkspaceRoot, loadEnv, loadEnvFile } from "@agentsales/config";
import { isAppError, llmCallCost } from "@agentsales/core";
import { createAnthropicApiProvider } from "../anthropic-api.js";
import { claudeCliArgs, claudeCliEnv, interpretEnvelope, parseEnvelope } from "../claude-cli.js";

// Prueba de humo de la CLI de Claude (spec F2-T04). La corre el operador en su terminal, con la
// sesión de su plan: hace UNA llamada corta con un aviso inventado (sin datos de clientes), guarda
// el sobre en tmp/llm-smoke/ para fijar el ejecutable falso de los tests, y muestra cómo lo
// interpreta el adaptador. No la corre ningún test.
// Con `--provider anthropic-api` (F7-T11): UNA llamada a la API de Anthropic con la clave del
// `.env` (gasta centavos), y muestra el modelo, los tokens y el costo estimado. Nunca la clave.
loadEnvFile();
const env = loadEnv();
const { values: args } = parseArgs({
  options: { provider: { type: "string" }, model: { type: "string" } },
});
const outDir = join(findWorkspaceRoot(), "tmp", "llm-smoke");

const request = {
  system:
    "Eres un redactor de avisos inmobiliarios en español de Chile. Responde solo con los datos entregados.",
  prompt: JSON.stringify({
    aviso: { operacion: "Venta", tipo: "Departamento", comuna: "Comuna Inventada", dormitorios: 2 },
    tarea: "Escribe un gancho de una línea para Instagram, sin superlativos.",
  }),
  jsonSchema: {
    type: "object",
    properties: { hook: { type: "string" } },
    required: ["hook"],
    additionalProperties: false,
  },
};

if (args.provider === "anthropic-api") {
  if (env.ANTHROPIC_API_KEY === undefined || env.ANTHROPIC_API_KEY === "") {
    console.error("Falta ANTHROPIC_API_KEY en el .env");
    process.exit(1);
  }
  const model = args.model ?? env.ANTHROPIC_MODEL;
  const api = createAnthropicApiProvider({
    apiKey: env.ANTHROPIC_API_KEY,
    model,
    timeoutMs: env.LLM_TIMEOUT_SECONDS * 1000,
  });
  const started = Date.now();
  try {
    const response = await api.generateStructured(request);
    console.log(`API de Anthropic · modelo pedido: ${model} · respondió: ${response.model}`);
    console.log(`${Date.now() - started} ms`);
    if (response.usage !== undefined) {
      const cost = llmCallCost("anthropic-api", response.model, response.usage);
      console.log(
        `Tokens: entrada ${cost.inputTokens} (caché: escritos ${cost.cacheCreationInputTokens}, leídos ${cost.cacheReadInputTokens}) · salida ${cost.outputTokens}`,
      );
      console.log(
        `Costo estimado: US$ ${cost.costUsd.toFixed(5)} (tabla ${cost.priceTable ?? "sin precio para este modelo"})`,
      );
    }
    console.log(`Salida estructurada: ${JSON.stringify(response.data)}`);
  } catch (error) {
    console.error(isAppError(error) ? `✗ ${error.code}: ${error.message}` : `✗ ${String(error)}`);
    process.exitCode = 1;
  }
  process.exit();
}
if (args.provider !== undefined && args.provider !== "claude-cli") {
  console.error("--provider acepta claude-cli (por defecto) o anthropic-api");
  process.exit(1);
}

const help = spawnSync(env.CLAUDE_CLI_PATH, ["-p", "--help"], { encoding: "utf8" });
const maxTurns = (help.stdout ?? "").includes("--max-turns");

// `spawnSync` con `timeout` corta solo a la CLI, no a sus hijos: es un script manual y corto.
const cwd = await mkdtemp(join(tmpdir(), "agentsales-claude-smoke-"));
const started = Date.now();
const run = spawnSync(env.CLAUDE_CLI_PATH, claudeCliArgs(request, env.LLM_MODEL), {
  cwd,
  env: claudeCliEnv(process.env),
  input: request.prompt,
  encoding: "utf8",
  timeout: env.LLM_TIMEOUT_SECONDS * 1000,
});
await rm(cwd, { recursive: true, force: true });

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "stdout.txt"), run.stdout ?? "", "utf8");
await writeFile(join(outDir, "stderr.txt"), run.stderr ?? "", "utf8");

console.log(`CLI: ${env.CLAUDE_CLI_PATH} · modelo pedido: ${env.LLM_MODEL}`);
console.log(`--max-turns en la ayuda: ${maxTurns ? "sí" : "no"}`);
console.log(`Código de salida: ${run.status} · ${Date.now() - started} ms`);

const envelope = parseEnvelope(run.stdout ?? "");
if (envelope === null) {
  console.error(
    "La salida no es el sobre JSON esperado: revisa tmp/llm-smoke/stdout.txt y stderr.txt",
  );
  process.exit(1);
}
await writeFile(join(outDir, "envelope.json"), JSON.stringify(envelope, null, 2), "utf8");
console.log(`Campos del sobre: ${Object.keys(envelope).sort().join(", ")}`);
try {
  const result = interpretEnvelope(envelope, env.LLM_MODEL);
  console.log(`OK · modelo: ${result.model}`);
  console.log(`Salida estructurada: ${JSON.stringify(result.data)}`);
} catch (error) {
  console.error(`El adaptador lo leyó como ${isAppError(error) ? error.code : String(error)}`);
  process.exitCode = 1;
}
console.log("Sobre guardado en tmp/llm-smoke/envelope.json");
