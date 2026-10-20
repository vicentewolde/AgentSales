import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { findWorkspaceRoot, loadEnv, loadEnvFile } from "@agentsales/config";
import { isAppError, LLM_PROVIDERS, type LlmProvider } from "@agentsales/core";
import { createLlmProvider } from "@agentsales/llm";
import { evalFolderName } from "../eval/run-eval.js";
import { runSocialEval } from "../eval/run-social-eval.js";
import { fakeSocialEvalOptions, parseIdeas, selectProfiles } from "../eval/social-options.js";
import { apiLlmOptions, llmProviderOptions } from "../llm-options.js";

// `pnpm eval:social [--provider fake|claude-cli|anthropic-api] [--model <id>] [--profile <nombre>]
// [--ideas N] [--out]` (spec F9-T22): el plan de ideas y los textos de algunas ideas sobre los
// perfiles de prueba de `src/eval/social-profiles.ts`, **sin la base** (no se conecta a ella).
// `--provider fake` no gasta cuota ni lee el `.env`; sin `--provider`, el de `LLM_PROVIDER`. La CLI
// de Claude gasta cuota del plan y la API, dinero (imprime el costo estimado): lo corre el operador.

/** Qué hacer ante los errores que tienen arreglo del lado del operador (según el proveedor). */
const hintFor = (code: string, provider: LlmProvider | undefined): string | undefined => {
  if (code === "LLM_AUTH_REQUIRED") {
    return provider === "anthropic-api"
      ? "Revisa ANTHROPIC_API_KEY en el .env (¿venció o la revocaron?)"
      : "Abre `claude` y usa /login";
  }
  if (code === "LLM_UNAVAILABLE" || code === "LLM_TIMEOUT") {
    return "La IA no respondió: revisa la conexión a internet y reintenta en unos minutos";
  }
  if (code === "LLM_NOT_CONFIGURED")
    return "Revisa LLM_PROVIDER, CLAUDE_CLI_PATH o la clave en el .env";
  if (code === "LLM_RATE_LIMITED" || code === "LLM_ACCOUNT_LIMIT") {
    return "Se acabó el límite de uso o el saldo: reintenta más tarde o revisa la consola";
  }
  return undefined;
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

let providerName: LlmProvider | undefined;
try {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      profile: { type: "string" },
      ideas: { type: "string" },
      out: { type: "boolean", default: false },
    },
  });
  const requested = values.provider;
  if (requested !== undefined && !(LLM_PROVIDERS as readonly string[]).includes(requested)) {
    throw new Error(
      `--provider acepta ${LLM_PROVIDERS.join(", ")} (sin la opción se usa LLM_PROVIDER del .env)`,
    );
  }
  const profiles = selectProfiles(values.profile);
  const ideas = parseIdeas(values.ideas);

  // Con `--provider fake` no hace falta el `.env`: ni la base ni la IA.
  let provider = requested as LlmProvider | undefined;
  let env: ReturnType<typeof loadEnv> | undefined;
  if (provider !== "fake") {
    loadEnvFile();
    env = loadEnv();
    provider ??= env.LLM_PROVIDER;
  }
  if (values.model !== undefined && provider === "fake") {
    throw new Error("--model va con --provider claude-cli o anthropic-api");
  }
  providerName = provider;

  let planLlm: ReturnType<typeof createLlmProvider>;
  let textLlm: ReturnType<typeof createLlmProvider>;
  if (provider === "fake" || env === undefined) {
    const fake = fakeSocialEvalOptions();
    planLlm = createLlmProvider(fake.plan);
    textLlm = createLlmProvider(fake.texts);
  } else if (provider === "anthropic-api") {
    // `--model <id>` compara modelos de la API con la clave del `.env` (como `eval:content`).
    const api = apiLlmOptions({
      ...env,
      ...(values.model === undefined ? {} : { ANTHROPIC_MODEL: values.model }),
    });
    if (api === null)
      throw new Error("--provider anthropic-api necesita ANTHROPIC_API_KEY en el .env");
    planLlm = createLlmProvider(api);
    textLlm = planLlm;
  } else {
    planLlm = createLlmProvider(
      llmProviderOptions(
        {
          ...env,
          LLM_PROVIDER: "claude-cli",
          ...(values.model === undefined ? {} : { LLM_MODEL: values.model }),
        },
        process.env,
      ),
    );
    textLlm = planLlm;
  }

  console.log(
    `Evaluando con ${provider} ${profiles.length === 1 ? "el perfil" : "los perfiles"} ` +
      `${profiles.map((item) => item.name).join(", ")} (textos de hasta ${ideas} ideas por perfil)…`,
  );
  const { exitCode, report } = await runSocialEval(
    { planLlm, textLlm, print: (line) => console.log(line) },
    { profiles, ideas, signal: abort.signal },
  );
  for (const code of new Set(report.profiles.flatMap((item) => item.failures.map((f) => f.code)))) {
    const hint = hintFor(code, providerName);
    if (hint) console.error(`  → ${code}: ${hint}`);
  }
  if (values.out) {
    const dir = join(findWorkspaceRoot(), "tmp", "eval-social");
    const path = join(dir, `${evalFolderName(new Date())}.json`);
    await mkdir(dir, { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`Informe en ${path}`);
  }
  if (provider === "anthropic-api") {
    console.log("La cifra oficial está en la consola de Anthropic.");
  }
  process.exitCode = exitCode;
} catch (error) {
  if (isAppError(error)) {
    console.error(`✗ ${error.code}: ${error.message}`);
    const hint = hintFor(error.code, providerName);
    if (hint) console.error(`  → ${hint}`);
  } else {
    // Un `.env` inválido, una opción desconocida o un fallo inesperado: el mensaje, sin la pila.
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
}
