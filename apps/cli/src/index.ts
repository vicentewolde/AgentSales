#!/usr/bin/env node
import { Command } from "commander";
import { createHealthFetcher } from "./api-client.js";
import { colors } from "./colors.js";
import { renderDoctor, runDoctor } from "./doctor.js";
import { apiPort, loadEnvironment } from "./env.js";
import { runStatus } from "./status.js";
import { findChromium, runCommand } from "./system.js";
import { readCliVersion } from "./version.js";

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

try {
  await program.parseAsync();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(colors.red(`✗ Error inesperado: ${message}`));
  process.exitCode = 1;
}
