import { randomUUID } from "node:crypto";
import {
  createErrorThrottle,
  createLogger,
  createSecretBox,
  createStateSigner,
  findWorkspaceRoot,
  loadEnv,
  loadEnvFile,
} from "@agentsales/config";
import {
  createBrokerRepository,
  createContentRepository,
  createContentRunRepository,
  createDb,
  createFieldDefinitionRepository,
  createImportRunRepository,
  createListingLock,
  createListingRepository,
  createMediaRepository,
  createPlatformAccountRepository,
  pingDatabase,
  toPgConnectionString,
} from "@agentsales/db";
import { createStaging, stagingRootOf } from "@agentsales/importers/staging";
import { createInstagramAuth } from "@agentsales/publishers";
import { checkQueueSchema, createJobQueue } from "@agentsales/queue";
import { createR2Storage } from "@agentsales/storage";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { localAccess } from "./security.js";
import { readApiVersion } from "./version.js";

/** Solo en local: la API no tiene autenticación hasta F7. */
const HOSTNAME = "127.0.0.1";
const HEALTHCHECK_PATH = "_healthcheck/ping";
/** Mayor que el tope de un check de `/health` (25 s), para dejar terminar lo que está en curso. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

loadEnvFile();
const env = loadEnv();
const logger = createLogger({
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV !== "production",
  name: "api",
});

const database = createDb(env.DATABASE_URL, {
  onError: (error) => logger.warn({ err: error }, "conexión inactiva cerrada por la base de datos"),
});
const storage = createR2Storage({
  accountId: env.R2_ACCOUNT_ID,
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  bucket: env.R2_BUCKET,
  signedUrlTtlSeconds: env.SIGNED_URL_TTL_SECONDS,
});

// La API solo encola (ADR-0005): pg-boss arranca en el primer `enqueue`, así la API levanta aunque
// el esquema `pgboss` no exista. Sus errores de fondo se resumen, como en el worker.
const queueErrors = createErrorThrottle(logger, "error de la cola (pg-boss)");
const queue = createJobQueue({
  connectionString: toPgConnectionString(env.DATABASE_URL),
  onError: (error) => queueErrors.report(error),
});
// El mismo staging que el worker (`<workspace>/tmp/imports`): en el MVP comparten disco (§4.6).
// La API solo escribe en el staging: leer medios (con su tope de video) es del worker.
const staging = createStaging({ root: stagingRootOf(findWorkspaceRoot()) });

// Un solo `SecretBox` para toda la API: el candado y (desde T13) el repositorio de cuentas cifran y
// descifran con la clave derivada de APP_ENCRYPTION_KEY (F3-T02).
const secretBox = createSecretBox(env.APP_ENCRYPTION_KEY);

const app = createApp({
  checks: {
    db: () => pingDatabase(database.db),
    // `head` devuelve null si el objeto no existe: basta con que no lance.
    storage: async () => {
      await storage.head(HEALTHCHECK_PATH);
    },
    // Solo lee el catálogo, sin pg-boss: `ok` es que la cola se inicializó alguna vez.
    queue: () => checkQueueSchema(database.db),
  },
  listings: createListingRepository(database.db),
  brokers: createBrokerRepository(database.db),
  media: createMediaRepository(database.db),
  fieldDefinitions: createFieldDefinitionRepository(database.db),
  storage,
  importRuns: createImportRunRepository(database.db),
  contentRuns: createContentRunRepository(database.db),
  contents: createContentRepository(database.db),
  lock: createListingLock(database.db, { secretBox }),
  platformAccounts: createPlatformAccountRepository(database.db, { secretBox }),
  instagram: {
    // Sin el par de la app, `/me` (conectar con el token del panel) funciona igual; solo el canje
    // del OAuth lo necesita, y `/oauth/instagram/start` vuelve al panel con INSTAGRAM_NOT_CONFIGURED.
    auth: createInstagramAuth({
      appId: env.INSTAGRAM_APP_ID ?? "",
      appSecret: env.INSTAGRAM_APP_SECRET ?? "",
      redirectUri: env.INSTAGRAM_REDIRECT_URI,
    }),
    oauthConfigured: Boolean(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET),
    secureCookie: env.INSTAGRAM_REDIRECT_URI.startsWith("https://"),
  },
  oauthState: createStateSigner(env.APP_ENCRYPTION_KEY),
  // El host del panel debe ser el mismo de la URI de retorno (la cookie distingue `localhost`).
  panelUrl: `http://localhost:${env.WEB_PORT}`,
  queue,
  uploads: {
    save: (runId, fileName, bytes) => staging.saveInput(runId, fileName, bytes),
    discard: (runId) => staging.discard(runId),
  },
  newId: randomUUID,
  // `POST /imports/local` lee rutas del disco del operador: solo en desarrollo (la CLI).
  localImports: env.NODE_ENV === "development",
  maxUploadBytes: env.MAX_IMPORT_UPLOAD_MB * 1024 * 1024,
  publishMode: env.PUBLISH_MODE,
  version: readApiVersion(),
  logger,
  access: localAccess(env.API_PORT, env.WEB_PORT),
});

const server = serve({ fetch: app.fetch, port: env.API_PORT, hostname: HOSTNAME }, (info) => {
  logger.info({ url: `http://${HOSTNAME}:${info.port}` }, "API escuchando");
  if (env.PUBLISH_MODE === "live") {
    logger.warn("PUBLISH_MODE=live: las publicaciones son reales");
  } else {
    logger.info("PUBLISH_MODE=dry-run: no se publica nada de verdad");
  }
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    logger.error(
      `El puerto ${env.API_PORT} está ocupado: ¿otra API corriendo? Cambia API_PORT o ciérrala.`,
    );
  } else {
    logger.error({ err: error }, "el servidor HTTP falló");
  }
  process.exit(1);
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "apagando la API");
  const force = setTimeout(() => {
    logger.error("el apagado tardó demasiado; se cierran las conexiones y se fuerza la salida");
    if ("closeAllConnections" in server) {
      server.closeAllConnections();
    }
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();
  // `close` deja de aceptar conexiones y espera a las activas; las ociosas las cierra Node.
  server.close((error) => {
    if (error) {
      logger.warn({ err: error }, "el servidor ya estaba cerrado");
    }
    queueErrors.dispose();
    Promise.all([queue.stop(), database.close()])
      .catch((closeError: unknown) =>
        logger.error({ err: closeError }, "error al cerrar la cola o la base"),
      )
      .finally(() => process.exit(0));
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
