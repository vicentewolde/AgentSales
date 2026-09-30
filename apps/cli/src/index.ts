#!/usr/bin/env node
import { EnvError, loadEnv, loadEnvFile } from "@agentsales/config";
import { Command } from "commander";
import { createHealthFetcher } from "./api-client.js";
import type { EnvResult } from "./checks.js";
import { colors } from "./colors.js";
import { renderDoctor, runDoctor } from "./doctor.js";
import { runStatus } from "./status.js";
import { findChromium, runCommand } from "./system.js";
import { readCliVersion } from "./version.js";

const DEFAULT_API_PORT = 8787;

/** Carga el `.env`; si es inválido, devuelve los problemas (sin valores) en vez de lanzar. */
function loadEnvironment(): EnvResult {
  const fileFound = loadEnvFile();
  try {
    return { ok: true, env: loadEnv() };
  } catch (error) {
    if (error instanceof EnvError) {
      return { ok: false, fileFound, issues: error.issues };
    }
    throw error;
  }
}

/** Puerto de la API aunque el `.env` sea inválido (para poder diagnosticar igual). */
function apiPort(env: EnvResult): number {
  if (env.ok) {
    return env.env.API_PORT;
  }
  const raw = Number(process.env.API_PORT);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_API_PORT;
}

const program = new Command()
  .name("agentsales")
  .description("CLI de AgentSales")
  .version(readCliVersion());

program
  .command("doctor")
  .description("Revisa el entorno: .env, API, base, almacenamiento, cola y herramientas")
  .action(async () => {
    const env = loadEnvironment();
    const report = await runDoctor({
      nodeVersion: process.version,
      env,
      fetchHealth: createHealthFetcher(apiPort(env)),
      run: runCommand,
      chromiumDir: findChromium(),
    });
    console.log(renderDoctor(report, colors));
    process.exitCode = report.exitCode;
  });

program
  .command("status")
  .description("Estado de la API (/health) y PUBLISH_MODE")
  .action(async () => {
    const env = loadEnvironment();
    const result = await runStatus(createHealthFetcher(apiPort(env)), colors);
    console.log(result.text);
    process.exitCode = result.exitCode;
  });

await program.parseAsync();
