import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createLogger, createSecretBox, loadEnv, loadEnvFile } from "@agentsales/config";
import {
  createBrokerRepository,
  createContentRepository,
  createDb,
  createListingRepository,
  createMediaRepository,
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
import { createR2Storage } from "@agentsales/storage";
import { createWorkerPortal } from "../portal.js";
import { describeUnexpected } from "../smoke/ig-smoke.js";
import { runMlSmoke, smokeItems } from "../smoke/ml-smoke.js";
import {
  NO_PICTURE_BYTES,
  NO_PICTURES,
  readOnlyItems,
  recordingValidator,
  runMlSmokeListing,
} from "../smoke/ml-smoke-listing.js";

// `pnpm ml:smoke --listing <id_propiedad> [--broker <slug>]` (spec F4-T23): en vez del recorrido,
// arma el aviso real de esa propiedad con el publisher del worker (escrituras de ítems y fotos que
// lanzan un error) y le pregunta a `validate` si lo aceptaría, sin publicar. Necesita R2 (las URLs
// firmadas de las fotos) y el texto de Portal preparado.
//
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
      listing: { type: "string" },
    },
  });
  loadEnvFile();
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  database = db;
  const catalogRepository = createPlatformCatalogRepository(db.db);
  const mercadoLibre =
    env.ML_APP_ID && env.ML_CLIENT_SECRET
      ? createMercadoLibreAuth({
          appId: env.ML_APP_ID,
          clientSecret: env.ML_CLIENT_SECRET,
          redirectUri: env.ML_REDIRECT_URI,
        })
      : null;
  const accounts = createPlatformAccountRepository(db.db, {
    secretBox: createSecretBox(env.APP_ENCRYPTION_KEY),
  });
  const writeJson = async (name: string, generatedAt: string, report: unknown) => {
    await mkdir(REPORT_DIR, { recursive: true });
    const path = `${REPORT_DIR}${name}-${generatedAt.replace(/[:.]/g, "-")}.json`;
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return path;
  };
  if (values.listing !== undefined) {
    if (values.category !== undefined) {
      throw new Error("--category no va con --listing: la hoja sale de la propiedad");
    }
    const recorder = recordingValidator(createMercadoLibreValidator());
    const portal = createWorkerPortal({
      catalogRepository,
      storage: NO_PICTURE_BYTES,
      logger: createLogger({ level: "warn", pretty: true, name: "ml-smoke" }),
      clients: {
        items: readOnlyItems(createMercadoLibreItems()),
        pictures: NO_PICTURES,
        validator: recorder.validator,
      },
    });
    process.exitCode = await runMlSmokeListing(
      {
        accounts,
        brokers: createBrokerRepository(db.db),
        listings: createListingRepository(db.db),
        contents: createContentRepository(db.db),
        media: createMediaRepository(db.db),
        storage: createR2Storage({
          accountId: env.R2_ACCOUNT_ID,
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
          bucket: env.R2_BUCKET,
          signedUrlTtlSeconds: env.SIGNED_URL_TTL_SECONDS,
        }),
        mercadoLibre,
        publisher: portal.publisher,
        sentBodies: () => recorder.sent,
        writeReport: (report) => writeJson("ml-smoke-listing", report.generatedAt, report),
        now: () => new Date(),
        print: (line) => console.log(line),
        printError: (line) => console.error(line),
      },
      {
        listingRef: values.listing,
        ...(values.broker === undefined ? {} : { brokerSlug: values.broker }),
        signal: abort.signal,
      },
    );
  } else {
    process.exitCode = await runMlSmoke(
      {
        accounts,
        brokers: createBrokerRepository(db.db),
        listings: createListingRepository(db.db),
        mercadoLibre,
        catalog: createPortalCatalog({
          api: createMercadoLibreCatalogApi(),
          repository: catalogRepository,
          onNote: (note) =>
            console.error(`  Aviso: ${note.code} en ${note.key} (${note.errorCode})`),
        }),
        validator: createMercadoLibreValidator(),
        items: smokeItems(createMercadoLibreItems()),
        packs: createMercadoLibrePacks(),
        writeReport: (report) => writeJson("ml-smoke", report.generatedAt, report),
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
  }
} catch (error) {
  // Un `.env` inválido, una opción desconocida o un fallo inesperado: el mensaje, sin la pila ni URLs.
  console.error(`✗ ${describeUnexpected(error)}`);
  process.exitCode = 1;
} finally {
  await database?.close();
}
