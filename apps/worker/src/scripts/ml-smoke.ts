import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createSecretBox, loadEnv, loadEnvFile } from "@agentsales/config";
import {
  createBrokerRepository,
  createDb,
  createListingRepository,
  createPlatformAccountRepository,
  createPlatformCatalogRepository,
} from "@agentsales/db";
import {
  createMercadoLibreAuth,
  createMercadoLibreCatalogApi,
  createMercadoLibreItems,
  createMercadoLibrePacks,
  createMercadoLibreValidator,
  createPortalCatalog,
} from "@agentsales/publishers";
import { describeUnexpected } from "../smoke/ig-smoke.js";
import { runMlSmoke, smokeItems } from "../smoke/ml-smoke.js";

// `pnpm ml:smoke [--broker <slug>] [--category <MLC…>]` (spec F4-T10): recorre el catálogo de
// Inmuebles, las ubicaciones de Chile, `POST /items/validate` con un aviso de prueba, la búsqueda
// de ítems y los paquetes, **sin crear ni cambiar nada** en Mercado Libre. Habla con Mercado Libre
// de verdad: lo corre el operador, con la cuenta conectada. No necesita `pnpm dev` (lee la base
// directo). Escribe en la base el catálogo y, si lo renueva, el acceso de la cuenta. El informe
// completo queda en `tmp/ml-smoke/` (fuera de git).

/** `tmp/ml-smoke/` en la raíz del repo (este archivo está en `apps/worker/src/scripts`). */
const REPORT_DIR = fileURLToPath(new URL("../../../../tmp/ml-smoke/", import.meta.url));

// Ctrl+C corta las llamadas; un segundo Ctrl+C sale de inmediato.
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
      category: { type: "string" },
    },
  });
  loadEnvFile();
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  database = db;
  const catalogRepository = createPlatformCatalogRepository(db.db);
  process.exitCode = await runMlSmoke(
    {
      accounts: createPlatformAccountRepository(db.db, {
        secretBox: createSecretBox(env.APP_ENCRYPTION_KEY),
      }),
      brokers: createBrokerRepository(db.db),
      listings: createListingRepository(db.db),
      mercadoLibre:
        env.ML_APP_ID && env.ML_CLIENT_SECRET
          ? createMercadoLibreAuth({
              appId: env.ML_APP_ID,
              clientSecret: env.ML_CLIENT_SECRET,
              redirectUri: env.ML_REDIRECT_URI,
            })
          : null,
      catalog: createPortalCatalog({
        api: createMercadoLibreCatalogApi(),
        repository: catalogRepository,
        onNote: (note) => console.error(`  Aviso: ${note.code} en ${note.key} (${note.errorCode})`),
      }),
      validator: createMercadoLibreValidator(),
      items: smokeItems(createMercadoLibreItems()),
      packs: createMercadoLibrePacks(),
      async writeReport(report) {
        await mkdir(REPORT_DIR, { recursive: true });
        const stamp = report.generatedAt.replace(/[:.]/g, "-");
        const path = `${REPORT_DIR}ml-smoke-${stamp}.json`;
        await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
        return path;
      },
      now: () => new Date(),
      print: (line) => console.log(line),
      printError: (line) => console.error(line),
    },
    {
      ...(values.broker === undefined ? {} : { brokerSlug: values.broker }),
      ...(values.category === undefined ? {} : { categoryId: values.category }),
      signal: abort.signal,
    },
  );
} catch (error) {
  // Un `.env` inválido, una opción desconocida o un fallo inesperado: el mensaje, sin la pila ni URLs.
  console.error(`✗ ${describeUnexpected(error)}`);
  process.exitCode = 1;
} finally {
  await database?.close();
}
