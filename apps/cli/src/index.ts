#!/usr/bin/env node
import { Command } from "commander";
import { colors } from "./colors.js";
import * as accounts from "./commands/accounts.js";
import * as approve from "./commands/approve.js";
import * as content from "./commands/content.js";
import * as doctor from "./commands/doctor/index.js";
import * as importCommand from "./commands/import.js";
import * as imports from "./commands/imports.js";
import * as listing from "./commands/listing.js";
import * as listings from "./commands/listings.js";
import * as prepare from "./commands/prepare.js";
import * as publications from "./commands/publications.js";
import * as publish from "./commands/publish.js";
import * as status from "./commands/status.js";
import { createContext } from "./context.js";
import { readCliVersion } from "./version.js";

const program = new Command()
  .name("agentsales")
  .description("CLI de AgentSales")
  .version(readCliVersion());

// Un comando por archivo (spec F1-T12), cada uno con su `register`.
const ctx = createContext();
for (const command of [
  doctor,
  status,
  importCommand,
  imports,
  listings,
  listing,
  prepare,
  content,
  approve,
  publish,
  publications,
  accounts,
]) {
  command.register(program, ctx);
}

try {
  await program.parseAsync();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(colors.red(`✗ Error inesperado: ${message}`));
  process.exitCode = 1;
}
