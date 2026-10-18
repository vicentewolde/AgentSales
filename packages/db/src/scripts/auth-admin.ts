import { parseArgs } from "node:util";
import {
  clipboardReady,
  copyToClipboard,
  createSecretTokens,
  loadEnv,
  loadEnvFile,
  panelUrlOf,
} from "@agentsales/config";
import { runAuthAdmin } from "../auth-admin.js";
import { createDb } from "../client.js";
import {
  createInvitationRepository,
  createSessionRepository,
  createUserRepository,
} from "../repositories/users.js";

// `pnpm auth:admin --email <correo> [--name "Nombre"]` (F7-T05): ver `../auth-admin.ts`.

loadEnvFile();
const env = loadEnv();
const { values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" } } });
const { db, close } = createDb(env.DATABASE_URL);
try {
  process.exitCode = await runAuthAdmin(
    {
      users: createUserRepository(db),
      sessions: createSessionRepository(db),
      invitations: createInvitationRepository(db),
      tokens: createSecretTokens(),
      // Con `ENV_FILE=.env.production`, el enlace va al panel del servidor (spec F8 §4.2).
      panelUrl: panelUrlOf(env),
      clipboardReady,
      copyToClipboard,
      print: (line) => console.log(line),
      printError: (line) => console.error(line),
    },
    { email: values.email, name: values.name },
  );
} finally {
  await close();
}
