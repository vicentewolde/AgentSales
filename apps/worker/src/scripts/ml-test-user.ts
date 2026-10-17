import { parseArgs } from "node:util";
import {
  clipboardReady,
  copyToClipboard,
  createSecretBox,
  loadEnv,
  loadEnvFile,
} from "@agentsales/config";
import { createBrokerRepository, createDb, createPlatformAccountRepository } from "@agentsales/db";
import { createMercadoLibreAuth, createMercadoLibreTestUsers } from "@agentsales/publishers";
import { describeUnexpected } from "../smoke/ig-smoke.js";
import { runMlTestUser } from "../smoke/ml-test-user.js";

// `pnpm ml:test-user --broker <slug>` (spec F4-T25): crea un usuario de prueba de Mercado Libre
// Chile con la cuenta real conectada al corredor y deja su clave en el portapapeles (`pbcopy`),
// sin imprimirla. Habla con Mercado Libre de verdad: lo corre el operador, en la terminal de su
// Mac. No necesita `pnpm dev` (lee la base directo); si renueva el acceso, lo guarda (con el
// candado). Sigue con la checklist (docs/07-checklist-cuentas.md).

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
      clipboardReady,
      copyToClipboard,
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
