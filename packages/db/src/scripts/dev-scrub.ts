import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs, parseEnv } from "node:util";
import {
  createSecretBox,
  EnvError,
  EnvFileError,
  findWorkspaceRoot,
  loadEnv,
  loadEnvFile,
} from "@agentsales/config";
import { isAppError } from "@agentsales/core";
import { createDb } from "../client.js";
import { runDevScrub } from "../dev-scrub.js";

// `pnpm db:dev-scrub [--yes]` (spec F8 §4.6): ver `../dev-scrub.ts`. Lee `.env` (nunca `ENV_FILE`) y,
// si existe, `.env.production` solo para comparar la base y la clave; no imprime ninguna de las dos.

const envFile = process.env.ENV_FILE;
const { values } = parseArgs({ options: { yes: { type: "boolean", default: false } } });

async function confirm(question: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^s(i|í)?$/i.test((await terminal.question(question)).trim());
  } finally {
    terminal.close();
  }
}

try {
  if (envFile !== undefined && envFile.trim() !== "") {
    console.error(
      `✗ No se borró nada: ENV_FILE=${envFile.trim()}: este script usa solo .env (la rama de desarrollo); quita ENV_FILE de la terminal`,
    );
    process.exitCode = 1;
  } else {
    const root = findWorkspaceRoot();
    loadEnvFile(root, undefined);
    const env = loadEnv();
    const productionPath = join(root, ".env.production");
    const production = existsSync(productionPath)
      ? parseEnv(readFileSync(productionPath, "utf8"))
      : null;
    const { db, close } = createDb(env.DATABASE_URL);
    try {
      process.exitCode = await runDevScrub(
        {
          db,
          secretBox: createSecretBox(env.APP_ENCRYPTION_KEY),
          databaseUrl: env.DATABASE_URL,
          appEncryptionKey: env.APP_ENCRYPTION_KEY,
          nodeEnv: env.NODE_ENV,
          envFile,
          production:
            production === null
              ? null
              : {
                  databaseUrl: production.DATABASE_URL,
                  appEncryptionKey: production.APP_ENCRYPTION_KEY,
                },
          confirm,
          print: (line) => console.log(line),
          printError: (line) => console.error(line),
        },
        { yes: values.yes },
      );
    } finally {
      await close();
    }
  }
} catch (error) {
  // Un `.env` inválido nombra las variables, nunca sus valores; un error de la base, su código.
  console.error(
    error instanceof EnvError || error instanceof EnvFileError
      ? error.message
      : isAppError(error)
        ? `✗ ${error.code}: ${error.message}`
        : error,
  );
  process.exitCode = 1;
}
