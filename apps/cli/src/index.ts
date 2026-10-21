#!/usr/bin/env node
import { Command } from "commander";
import { colors } from "./colors.js";
import * as accounts from "./commands/accounts.js";
import * as agenda from "./commands/agenda.js";
import * as approve from "./commands/approve.js";
import * as brand from "./commands/brand.js";
import * as brokers from "./commands/brokers.js";
import * as content from "./commands/content.js";
import * as doctor from "./commands/doctor/index.js";
import * as importCommand from "./commands/import.js";
import * as imports from "./commands/imports.js";
import * as listing from "./commands/listing.js";
import * as listings from "./commands/listings.js";
import * as login from "./commands/login.js";
import * as plan from "./commands/plan.js";
import * as post from "./commands/post.js";
import * as prepare from "./commands/prepare.js";
import * as publications from "./commands/publications.js";
import * as publish from "./commands/publish.js";
import * as schedule from "./commands/schedule.js";
import * as status from "./commands/status.js";
import * as tracking from "./commands/tracking.js";
import * as usage from "./commands/usage.js";
import * as users from "./commands/users.js";
import { createContext } from "./context.js";
import { readCliVersion } from "./version.js";

const program = new Command()
  .name("agentsales")
  .description("CLI de AgentSales")
  .version(readCliVersion());

// Un comando por archivo (spec F1-T12), cada uno con su `register`.
const ctx = createContext();
for (const command of [
  login,
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
  schedule,
  agenda,
  tracking,
  accounts,
  brokers,
  brand,
  post,
  plan,
  users,
  usage,
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
