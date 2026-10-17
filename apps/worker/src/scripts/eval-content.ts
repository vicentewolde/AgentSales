import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { findWorkspaceRoot, loadEnv, loadEnvFile } from "@agentsales/config";
import { isAppError, type LLMProvider, llmCallCost, SAMPLE_CONTENT_DRAFT } from "@agentsales/core";
import {
  createBrokerRepository,
  createDb,
  createFieldDefinitionRepository,
  createListingRepository,
} from "@agentsales/db";
import { createLlmProvider } from "@agentsales/llm";
import { DEFAULT_EVAL_BROKER, evalFolderName, runEval } from "../eval/run-eval.js";
import { apiLlmOptions, llmProviderOptions } from "../llm-options.js";

// `pnpm eval:content [--broker <slug>] [--provider fake|anthropic-api] [--model <id>]` (spec F2-T16;
// la API desde F7): evalúa el prompt sobre los
// avisos listos de un corredor, sin escribir en la base. Sin `--provider fake`, usa el proveedor del
// `.env` (la CLI de Claude gasta cuota del plan: lo corre el operador).

/** Qué hacer ante los errores que tienen arreglo del lado del operador. */
const HINTS: Readonly<Record<string, string>> = {
  DB_UNAVAILABLE: "Neon puede estar despertando: reintenta en unos segundos",
  LLM_AUTH_REQUIRED: "Abre `claude` y usa /login",
};

// Ctrl+C corta también la llamada a la CLI de Claude en curso: corre en su propio grupo de
// procesos y no recibe la señal de la terminal, así que seguiría gastando cuota.
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (abort.signal.aborted) process.exit(130);
    console.error("\nCortando la evaluación…");
    abort.abort();
  });
}

let database: ReturnType<typeof createDb> | undefined;
try {
  const { values } = parseArgs({
    options: {
      broker: { type: "string", default: DEFAULT_EVAL_BROKER },
      provider: { type: "string" },
      model: { type: "string" },
    },
  });
  if (
    values.provider !== undefined &&
    values.provider !== "fake" &&
    values.provider !== "anthropic-api"
  ) {
    throw new Error(
      "--provider acepta fake o anthropic-api (sin la opción se usa LLM_PROVIDER del .env)",
    );
  }
  loadEnvFile();
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  database = db;
  // `--provider anthropic-api [--model <id>]` (F7, D15): compara modelos con la clave del `.env`.
  const api = apiLlmOptions({
    ...env,
    ...(values.model === undefined ? {} : { ANTHROPIC_MODEL: values.model }),
  });
  if (values.provider === "anthropic-api" && api === null) {
    throw new Error("--provider anthropic-api necesita ANTHROPIC_API_KEY en el .env");
  }
  const provider = createLlmProvider(
    values.provider === "fake"
      ? { provider: "fake", data: SAMPLE_CONTENT_DRAFT }
      : values.provider === "anthropic-api" && api !== null
        ? api
        : llmProviderOptions(env, process.env),
  );
  // El costo estimado de las respuestas (con la API; el plan y fake cuestan 0).
  const spent = { calls: 0, costUsd: 0 };
  const llm: LLMProvider = {
    name: provider.name,
    async generateStructured(request) {
      const response = await provider.generateStructured(request);
      if (response.usage !== undefined) {
        spent.calls += 1;
        spent.costUsd += llmCallCost(provider.name, response.model, response.usage).costUsd;
      }
      return response;
    },
  };
  console.log(`Evaluando con ${llm.name} las propiedades listas de ${values.broker}…`);
  process.exitCode = await runEval(
    {
      listings: createListingRepository(db.db),
      brokers: createBrokerRepository(db.db),
      fieldDefinitions: createFieldDefinitionRepository(db.db),
      llm,
      outDir: join(findWorkspaceRoot(), "tmp", "eval", evalFolderName(new Date())),
      writeFile: async (path, text) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text, "utf8");
      },
      print: (line) => console.log(line),
      printError: (line) => console.error(line),
    },
    { brokerSlug: values.broker, signal: abort.signal },
  );
  if (llm.name === "anthropic-api") {
    console.log(
      `Costo estimado: US$ ${spent.costUsd.toFixed(4)} en ${spent.calls} llamadas (la cifra oficial está en la consola de Anthropic)`,
    );
  }
} catch (error) {
  if (isAppError(error)) {
    console.error(`✗ ${error.code}: ${error.message}`);
    const hint = HINTS[error.code];
    if (hint) console.error(`  → ${hint}`);
  } else {
    // Un `.env` inválido, una opción desconocida o un fallo inesperado: el mensaje, sin la pila.
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
} finally {
  await database?.close();
}
