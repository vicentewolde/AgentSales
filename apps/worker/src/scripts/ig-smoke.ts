import { parseArgs } from "node:util";
import { createSecretBox, loadEnv, loadEnvFile } from "@agentsales/config";
import {
  createBrokerRepository,
  createDb,
  createListingRepository,
  createMediaRepository,
  createPlatformAccountRepository,
} from "@agentsales/db";
import { abortableSleep, createInstagramGraph } from "@agentsales/publishers";
import { createR2Storage } from "@agentsales/storage";
import { runIgSmoke } from "../smoke/ig-smoke.js";

// `pnpm ig:smoke [--broker <slug>] [--listing <id_propiedad>]` (spec F3-T19): crea un contenedor de
// imagen en Instagram desde una URL firmada de R2 y espera a que Meta lo procese, **sin publicar**.
// Habla con Meta de verdad: lo corre el operador, con la cuenta conectada. No necesita `pnpm dev`
// (lee la base directo) y no escribe en ella.

// Ctrl+C corta el sondeo; un segundo Ctrl+C sale de inmediato.
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (abort.signal.aborted) process.exit(130);
    console.error("\nCortando el smoke…");
    abort.abort();
  });
}

let database: ReturnType<typeof createDb> | undefined;
try {
  const { values } = parseArgs({
    options: {
      broker: { type: "string" },
      listing: { type: "string" },
    },
  });
  loadEnvFile();
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  database = db;
  process.exitCode = await runIgSmoke(
    {
      accounts: createPlatformAccountRepository(db.db, {
        secretBox: createSecretBox(env.APP_ENCRYPTION_KEY),
      }),
      brokers: createBrokerRepository(db.db),
      listings: createListingRepository(db.db),
      media: createMediaRepository(db.db),
      storage: createR2Storage({
        accountId: env.R2_ACCOUNT_ID,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: env.R2_BUCKET,
        signedUrlTtlSeconds: env.SIGNED_URL_TTL_SECONDS,
      }),
      graph: createInstagramGraph(),
      sleep: abortableSleep,
      now: () => performance.now(),
      print: (line) => console.log(line),
      printError: (line) => console.error(line),
    },
    {
      ...(values.broker === undefined ? {} : { brokerSlug: values.broker }),
      ...(values.listing === undefined ? {} : { listingRef: values.listing }),
      signal: abort.signal,
    },
  );
} catch (error) {
  // Un `.env` inválido, una opción desconocida o un fallo inesperado: el mensaje, sin la pila.
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await database?.close();
}
