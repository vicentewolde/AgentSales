import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { findWorkspaceRoot, loadEnv, loadEnvFile } from "@agentsales/config";
import { SAMPLE_CONTENT_DRAFT } from "@agentsales/core";
import {
  createBrokerRepository,
  createDb,
  createFieldDefinitionRepository,
  createListingRepository,
} from "@agentsales/db";
import { createLlmProvider } from "@agentsales/llm";
import { DEFAULT_EVAL_BROKER, runEval } from "../eval/run-eval.js";
import { llmProviderOptions } from "../llm-options.js";

// `pnpm eval:content [--broker <slug>] [--provider fake]` (spec F2-T16): evalúa el prompt sobre los
// avisos listos de un corredor, sin escribir en la base. Sin `--provider fake`, usa el proveedor del
// `.env` (la CLI de Claude gasta cuota del plan: lo corre el operador).
const { values } = parseArgs({
  options: {
    broker: { type: "string", default: DEFAULT_EVAL_BROKER },
    provider: { type: "string" },
  },
});
if (values.provider !== undefined && values.provider !== "fake") {
  console.error("✗ --provider solo acepta fake (sin la opción se usa LLM_PROVIDER del .env)");
  process.exit(1);
}

loadEnvFile();
const env = loadEnv();
const database = createDb(env.DATABASE_URL);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(findWorkspaceRoot(), "tmp", "eval", stamp);
const llm = createLlmProvider(
  values.provider === "fake"
    ? { provider: "fake", data: SAMPLE_CONTENT_DRAFT }
    : llmProviderOptions(env, process.env),
);
console.log(`Evaluando con ${llm.name} las propiedades listas de ${values.broker}…`);

try {
  process.exitCode = await runEval(
    {
      listings: createListingRepository(database.db),
      brokers: createBrokerRepository(database.db),
      fieldDefinitions: createFieldDefinitionRepository(database.db),
      llm,
      outDir,
      writeFile: async (path, text) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text, "utf8");
      },
      print: (line) => console.log(line),
      printError: (line) => console.error(line),
    },
    { brokerSlug: values.broker },
  );
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await database.close();
}
