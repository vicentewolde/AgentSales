import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWorkspaceRoot, loadEnv, loadEnvFile } from "@agentsales/config";
import { isAppError } from "@agentsales/core";
import { claudeCliArgs, claudeCliEnv, interpretEnvelope, parseEnvelope } from "../claude-cli.js";

// Prueba de humo de la CLI de Claude (spec F2-T04). La corre el operador en su terminal, con la
// sesión de su plan: hace UNA llamada corta con un aviso inventado (sin datos de clientes), guarda
// el sobre en tmp/llm-smoke/ para fijar el ejecutable falso de los tests, y muestra cómo lo
// interpreta el adaptador. No la corre ningún test.
loadEnvFile();
const env = loadEnv();
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
