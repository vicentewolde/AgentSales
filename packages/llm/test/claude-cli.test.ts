import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAppError, type LLMRequest } from "@agentsales/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLAUDE_CLI_ENV_ALLOWLIST,
  type ClaudeCliOptions,
  createClaudeCliProvider,
  createLlmProvider,
} from "../src/index.js";
import { createFakeClaude } from "./fake-claude.js";

let fake: { cliPath: string; dir: string };
let workDir: string;
beforeAll(async () => {
  fake = await createFakeClaude();
  workDir = await mkdtemp(join(tmpdir(), "agentsales-llm-test-"));
});
afterAll(async () => {
  await rm(fake.dir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

/** El entorno de las apps, con secretos que la CLI nunca debe recibir (valores inventados). */
const APP_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  USER: "operador",
  LANG: "es_CL.UTF-8",
  TMPDIR: tmpdir(),
  DATABASE_URL: "postgresql://falso:falso@host/db?sslmode=require",
  R2_SECRET_ACCESS_KEY: "secreto-falso",
  APP_ENCRYPTION_KEY: "k".repeat(32),
  ANTHROPIC_API_KEY: "sk-ant-clave-falsa",
  ANTHROPIC_AUTH_TOKEN: "token-falso",
  CLAUDE_CODE_USE_BEDROCK: "1",
};

const provider = (overrides: Partial<ClaudeCliOptions> = {}) =>
  createClaudeCliProvider({
    cliPath: fake.cliPath,
    model: "sonnet",
    timeoutMs: 10_000,
    baseEnv: APP_ENV,
    tmpDir: workDir,
    killGraceMs: 100,
    ...overrides,
  });

const request = (mode: string, overrides: Partial<LLMRequest> = {}): LLMRequest => ({
  system: "Eres un redactor de avisos inmobiliarios.",
  prompt: `Datos del aviso (inventados). MODO:${mode}`,
  jsonSchema: { type: "object", properties: { saludo: { type: "string" } } },
  ...overrides,
});

async function errorOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isAppError(error)) throw new Error(`se esperaba un AppError: ${String(error)}`);
  return error;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("createClaudeCliProvider: respuestas", () => {
  it("devuelve structured_output sin validarlo y el modelo que respondió", async () => {
    await expect(provider().generateStructured(request("exito"))).resolves.toEqual({
      data: { saludo: "hola" },
      model: "claude-sonnet-5-5",
    });
  });

  it("sin modelUsage, el modelo es el configurado", async () => {
    const result = await provider({ model: "opus" }).generateStructured(request("sin-modelo"));
    expect(result.model).toBe("opus");
  });

  it.each([
    ["reintentos", "agotó los reintentos de la salida estructurada"],
    ["max-tokens", "se cortó por largo"],
    ["negativa", "se negó"],
    ["sin-salida", "respondió sin structured_output"],
  ])("%s → LLM_OUTPUT_INVALID, no reintentable (%s)", async (mode) => {
    const error = await errorOf(provider().generateStructured(request(mode)));
    expect([error.code, error.retriable]).toEqual(["LLM_OUTPUT_INVALID", false]);
  });

  it.each([
    ["sin-sesion", "LLM_AUTH_REQUIRED"],
    ["sesion-vencida", "LLM_AUTH_REQUIRED"],
    ["sin-sesion-texto", "LLM_AUTH_REQUIRED"],
    ["limite", "LLM_RATE_LIMITED"],
    ["saldo", "LLM_RATE_LIMITED"],
  ])("%s → %s, no reintentable y con un mensaje que dice qué hacer", async (mode, code) => {
    const error = await errorOf(provider().generateStructured(request(mode)));
    expect([error.code, error.retriable]).toEqual([code, false]);
    expect(error.message).toMatch(code === "LLM_AUTH_REQUIRED" ? /\/login/ : /intenta más tarde/);
  });

  it.each(["sobrecarga", "muere", "basura"])("%s → LLM_UNAVAILABLE, reintentable", async (mode) => {
    const error = await errorOf(provider().generateStructured(request(mode)));
    expect([error.code, error.retriable]).toEqual(["LLM_UNAVAILABLE", true]);
  });

  it("los mensajes de error no traen el prompt ni la respuesta del modelo", async () => {
    const error = await errorOf(provider().generateStructured(request("negativa")));
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toMatch(
      /Datos del aviso|No puedo ayudar/,
    );
  });

  it("una CLI que no existe es LLM_NOT_CONFIGURED", async () => {
    const error = await errorOf(
      provider({ cliPath: join(workDir, "no-existe", "claude") }).generateStructured(
        request("exito"),
      ),
    );
    expect([error.code, error.retriable]).toEqual(["LLM_NOT_CONFIGURED", false]);
  });
});

describe("createClaudeCliProvider: aislamiento (spec F2 §4.5)", () => {
  type Echo = {
    argv: string[];
    envKeys: string[];
    cwd: string;
    claudeMd: boolean;
    stdin: string;
  };
  let echo: Echo;
  const echoRequest = request("eco", {
    system: "Reglas editoriales de prueba",
    jsonSchema: { type: "object", properties: { a: { type: "string" } } },
  });
  beforeAll(async () => {
    echo = (await provider().generateStructured(echoRequest)).data as Echo;
  });

  it("recibe solo las variables permitidas: nada del .env ni claves de Anthropic", () => {
    const allowed = new Set<string>(CLAUDE_CLI_ENV_ALLOWLIST);
    // Node puede sumar variables propias del proceso (por ejemplo, `__CF_USER_TEXT_ENCODING` en
    // macOS); lo que importa es que no llegue nada de la app.
    for (const secret of [
      "DATABASE_URL",
      "R2_SECRET_ACCESS_KEY",
      "APP_ENCRYPTION_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
    ]) {
      expect(echo.envKeys).not.toContain(secret);
    }
    expect(echo.envKeys.filter((key) => allowed.has(key)).sort()).toEqual(
      [...CLAUDE_CLI_ENV_ALLOWLIST].sort(),
    );
  });

  it("el prompt va por stdin y nunca en los argumentos", () => {
    expect(echo.stdin).toBe(echoRequest.prompt);
    expect(echo.argv.join(" ")).not.toContain("Datos del aviso");
  });

  it("lleva salida JSON, el esquema, el modelo, el sistema propio y nada de herramientas ni configuración", () => {
    const argAfter = (flag: string) => echo.argv[echo.argv.indexOf(flag) + 1];
    expect(echo.argv[0]).toBe("-p");
    expect(argAfter("--output-format")).toBe("json");
    expect(JSON.parse(argAfter("--json-schema") ?? "")).toEqual(echoRequest.jsonSchema);
    expect(argAfter("--model")).toBe("sonnet");
    expect(argAfter("--system-prompt")).toBe("Reglas editoriales de prueba");
    expect(argAfter("--tools")).toBe("");
    for (const flag of [
      "--safe-mode",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
    ]) {
      expect(echo.argv).toContain(flag);
    }
    expect(echo.argv).not.toContain("--bare");
  });

  it("corre en un directorio vacío fuera del repo, sin CLAUDE.md arriba, que se borra al terminar", async () => {
    // El proceso ve la ruta real (en macOS, `/var` es un enlace a `/private/var`).
    expect(echo.cwd.startsWith(join(await realpath(workDir), "agentsales-claude-"))).toBe(true);
    expect(echo.claudeMd).toBe(false);
    expect(existsSync(echo.cwd)).toBe(false);
  });
});

describe("createClaudeCliProvider: tope de tiempo y corte", () => {
  const pidsFile = () => join(workDir, `pids-${Math.random().toString(36).slice(2)}.json`);
  const pidsOf = async (file: string): Promise<number[]> =>
    JSON.parse(await readFile(file, "utf8"));
  const waitUntilDead = async (pids: number[]) => {
    for (let attempt = 0; attempt < 50 && pids.some(alive); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return pids.filter(alive);
  };

  it("al vencer el tope: LLM_TIMEOUT reintentable, y la CLI y sus hijos terminan", async () => {
    const file = pidsFile();
    const error = await errorOf(
      provider({ timeoutMs: 500 }).generateStructured(
        request("cuelga", { prompt: `MODO:cuelga PIDS:${file}` }),
      ),
    );
    expect([error.code, error.retriable]).toEqual(["LLM_TIMEOUT", true]);
    expect(await waitUntilDead(await pidsOf(file))).toEqual([]);
  });

  it("una CLI que ignora SIGINT y SIGTERM termina igual (SIGKILL)", async () => {
    const file = pidsFile();
    const error = await errorOf(
      provider({ timeoutMs: 500 }).generateStructured(
        request("terco", { prompt: `MODO:terco PIDS:${file}` }),
      ),
    );
    expect(error.code).toBe("LLM_TIMEOUT");
    expect(await waitUntilDead(await pidsOf(file))).toEqual([]);
  });

  it("con signal: LLM_ABORTED reintentable, y los procesos terminan", async () => {
    const file = pidsFile();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const error = await errorOf(
      provider().generateStructured(
        request("cuelga", { prompt: `MODO:cuelga PIDS:${file}`, signal: controller.signal }),
      ),
    );
    expect([error.code, error.retriable]).toEqual(["LLM_ABORTED", true]);
    expect(await waitUntilDead(await pidsOf(file))).toEqual([]);
  });

  it("con signal ya disparado no espera: LLM_ABORTED", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await errorOf(
      provider().generateStructured(request("cuelga", { signal: controller.signal })),
    );
    expect(error.code).toBe("LLM_ABORTED");
  });
});

describe("createLlmProvider", () => {
  it("fake devuelve siempre una copia del dato configurado, sin red", async () => {
    const data = { instagram: { hook: "Gancho" } };
    const fakeProvider = createLlmProvider({ provider: "fake", data });
    const first = await fakeProvider.generateStructured(request("exito"));
    expect(first).toEqual({ data, model: "fake" });
    expect(first.data).not.toBe(data);
    expect(fakeProvider.name).toBe("fake");
  });

  it("anthropic-api es un stub en F2: LLM_NOT_CONFIGURED", async () => {
    const stub = createLlmProvider({ provider: "anthropic-api" });
    const error = await errorOf(stub.generateStructured(request("exito")));
    expect([stub.name, error.code, error.retriable]).toEqual([
      "anthropic-api",
      "LLM_NOT_CONFIGURED",
      false,
    ]);
  });

  it("claude-cli arma el adaptador de la CLI", async () => {
    const cli = createLlmProvider({
      provider: "claude-cli",
      cliPath: fake.cliPath,
      model: "sonnet",
      timeoutMs: 10_000,
      baseEnv: APP_ENV,
      tmpDir: workDir,
    });
    expect(cli.name).toBe("claude-cli");
    await expect(cli.generateStructured(request("exito"))).resolves.toMatchObject({
      data: { saludo: "hola" },
    });
  });
});
