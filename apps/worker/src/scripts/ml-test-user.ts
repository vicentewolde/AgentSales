import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { createSecretBox, loadEnv, loadEnvFile } from "@agentsales/config";
import { createBrokerRepository, createDb, createPlatformAccountRepository } from "@agentsales/db";
import { createMercadoLibreAuth, createMercadoLibreTestUsers } from "@agentsales/publishers";
import { describeUnexpected } from "../smoke/ig-smoke.js";
import { runMlTestUser } from "../smoke/ml-test-user.js";

// `pnpm ml:test-user --broker <slug>` (spec F4-T25): crea un usuario de prueba de Mercado Libre
// Chile con la cuenta real conectada al corredor y deja su clave en el portapapeles (`pbcopy`),
// sin imprimirla. Habla con Mercado Libre de verdad: lo corre el operador, en la terminal de su
// Mac. No necesita `pnpm dev` (lee la base directo); si renueva el acceso, lo guarda (con el
// candado). Sigue con la checklist (docs/07-checklist-cuentas.md).

/** Copia al portapapeles de macOS por la entrada estándar de `pbcopy` (nunca como argumento). */
function pbcopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`pbcopy terminó con ${code}`)),
    );
    child.stdin.end(text);
  });
}

const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (abort.signal.aborted) process.exit(130);
    console.error("\nCortando…");
    abort.abort();
  });
}

let database: ReturnType<typeof createDb> | undefined;
try {
  const { values } = parseArgs({ options: { broker: { type: "string" } } });
  if (values.broker === undefined) {
    throw new Error("Falta --broker <slug>: el corredor con tu cuenta real de Mercado Libre");
  }
  loadEnvFile();
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  database = db;
  process.exitCode = await runMlTestUser(
    {
      accounts: createPlatformAccountRepository(db.db, {
        secretBox: createSecretBox(env.APP_ENCRYPTION_KEY),
      }),
      brokers: createBrokerRepository(db.db),
      mercadoLibre:
        env.ML_APP_ID && env.ML_CLIENT_SECRET
          ? createMercadoLibreAuth({
              appId: env.ML_APP_ID,
              clientSecret: env.ML_CLIENT_SECRET,
              redirectUri: env.ML_REDIRECT_URI,
            })
          : null,
      testUsers: createMercadoLibreTestUsers(),
      // Copiar un texto vacío prueba `pbcopy` sin tocar nada (vacía el portapapeles).
      clipboardReady: () =>
        pbcopy("").then(
          () => true,
          () => false,
        ),
      copyToClipboard: pbcopy,
      now: () => new Date(),
      print: (line) => console.log(line),
      printError: (line) => console.error(line),
    },
    { brokerSlug: values.broker, signal: abort.signal },
  );
} catch (error) {
  // Un `.env` inválido, una opción desconocida o un fallo inesperado: el mensaje, sin la pila ni URLs.
  console.error(`✗ ${describeUnexpected(error)}`);
  process.exitCode = 1;
} finally {
  await database?.close();
}
